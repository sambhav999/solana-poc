/**
 * Kamino money movement: deposit, harvest withdrawal, principal withdrawal.
 *
 * All three follow the same shape: prepare an UNSIGNED transaction, let the
 * browser wallet sign it, then broadcast, confirm, and only then move the ledger.
 *
 * The principal floor is the thing every other guarantee rests on, so it moves
 * ONLY here and ONLY after a confirmed signature:
 *     deposit confirmed              -> floor += deposited
 *     principal withdrawal confirmed -> floor -= withdrawn
 *     harvest                        -> floor unchanged
 */
import {
  usdcToSharesFloor, principalWithdrawalPlan, applyDepositConfirmed,
  applyPrincipalWithdrawConfirmed, harvestableAtomic, defaultSafetyBufferAtomic,
  verifyFloorStillCovered, USDC_DECIMALS,
} from '../core/principal.js';
import { readPosition, buildDepositInstructions, buildWithdrawInstructions } from '../adapters/kamino/vault.js';
import { buildUnsignedTransaction } from '../adapters/solana/transaction.js';
import {
  sendRawTransactionBase64, confirmSignature, getTokenBalance, getSolBalanceLamports,
  getAccountOwnerProgram, SYSTEM_PROGRAM, USDC_MINT,
} from '../adapters/solana/rpc.js';
import { updateRule } from '../db/rules.js';
import { createReceipt } from '../db/receipts.js';
import { recordStranded, totalStrandedAtomic, listStranded } from '../db/stranded.js';

/* ------------------------------------------------------------------ util -- */

async function usdcBalance(owner) {
  const b = await getTokenBalance({ owner, mint: USDC_MINT }).catch(() => ({ rawAtomic: '0' }));
  return BigInt(b.rawAtomic);
}

/** Broadcast a signed transaction and hold until it reaches a terminal state. */
async function broadcastAndConfirm(signedTransactionBase64) {
  let signature;
  try {
    signature = await sendRawTransactionBase64(signedTransactionBase64);
  } catch (err) {
    return { ok: false, reason: 'BROADCAST_FAILED', detail: err.message };
  }
  const confirmation = await confirmSignature(signature);
  if (!confirmation.confirmed) {
    return { ok: false, reason: confirmation.reason, detail: JSON.stringify(confirmation.err ?? confirmation.lastStatus ?? null), signature };
  }
  return { ok: true, signature, slot: confirmation.slot, confirmationStatus: confirmation.confirmationStatus };
}

function requireVault(rule) {
  const vault = rule.kaminoVault || process.env.KAMINO_USDC_VAULT;
  if (!vault) throw new Error('No Kamino vault configured for this rule.');
  return vault;
}

/** Enough SOL to pay the signature and any token-account rent. */
const MIN_SOL_LAMPORTS = 3_000_000n; // 0.003 SOL

/**
 * Validate the fee payer before building anything.
 *
 * Two distinct failures both surface from the chain as a bare
 * `InvalidAccountForFee` during simulation, which tells a user nothing:
 *   - the account holds no SOL
 *   - the account is not system-owned (a token account or PDA cannot pay fees)
 * Both are checked here so the message is a sentence rather than an error code.
 */
async function requireSolForFees(owner) {
  const [lamports, account] = await Promise.all([
    getSolBalanceLamports(owner).catch(() => null),
    getAccountOwnerProgram(owner).catch(() => null),
  ]);

  if (account && account.owner !== SYSTEM_PROGRAM) {
    return {
      ok: false,
      reason: 'INVALID_FEE_PAYER',
      detail: `${owner} is owned by ${account.owner}, not the System Program. Only a normal wallet account can pay transaction fees; this looks like a token account or program-derived address.`,
    };
  }
  if (lamports !== null && lamports < MIN_SOL_LAMPORTS) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_SOL',
      detail: `Wallet holds ${Number(lamports) / 1e9} SOL. At least ${Number(MIN_SOL_LAMPORTS) / 1e9} SOL is needed for the signature and token-account rent.`,
    };
  }
  return { ok: true, lamports: lamports === null ? null : lamports.toString() };
}

/* --------------------------------------------------------------- deposit -- */

export async function prepareDeposit({ rule, usdcAtomic }) {
  const amount = BigInt(usdcAtomic);
  if (amount <= 0n) return { ok: false, reason: 'INVALID_AMOUNT', detail: 'deposit must be positive' };

  const vaultAddress = requireVault(rule);
  const walletUsdc = await usdcBalance(rule.wallet);
  if (walletUsdc < amount) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_USDC',
      detail: `wallet holds ${walletUsdc} atomic USDC, needs ${amount}`,
    };
  }

  const solCheck = await requireSolForFees(rule.wallet);
  if (!solCheck.ok) return solCheck;

  const before = await readPosition({ owner: rule.wallet, vaultAddress });
  if (!before.available) return { ok: false, reason: 'KAMINO_UNAVAILABLE', detail: before.detail };

  let built0;
  try {
    built0 = await buildDepositInstructions({ owner: rule.wallet, vaultAddress, usdcAtomic: amount });
  } catch (err) {
    return { ok: false, reason: 'KAMINO_IX_BUILD_FAILED', detail: err.message };
  }
  const { instructions, amountTokens, groups } = built0;
  const built = await buildUnsignedTransaction({ owner: rule.wallet, instructions });

  if (built.simulation && !built.simulation.ok) {
    return { ok: false, reason: 'SIMULATION_FAILED', detail: JSON.stringify(built.simulation.err), logs: built.simulation.logs };
  }

  return {
    ok: true,
    stage: 'DEPOSIT',
    transaction: built.transaction,
    simulation: built.simulation,
    context: {
      usdcAtomic: amount.toString(),
      amountTokens,
      vaultAddress,
      groups,
      redeemableBefore: before.redeemableAtomic,
      floorBefore: rule.principalFloorAtomic ?? '0',
    },
  };
}

export async function submitDeposit({ rule, signedTransaction, context }) {
  const result = await broadcastAndConfirm(signedTransaction);
  const vaultAddress = context.vaultAddress;

  if (!result.ok) {
    createReceipt({
      ruleId: rule.id, wallet: rule.wallet, kind: 'DEPOSIT', mode: 'LIVE', status: 'FAILED',
      executionKey: `deposit:${rule.id}:${Date.now()}`, signature: result.signature ?? null,
      inputs: context, outputs: {}, error: `${result.reason}: ${result.detail}`,
    });
    // The floor is untouched: nothing was confirmed, so nothing is claimed.
    return { ok: false, reason: result.reason, detail: result.detail, signature: result.signature ?? null };
  }

  // Cross-check the confirmed transaction against the position it should have moved.
  const after = await readPosition({ owner: rule.wallet, vaultAddress });
  const deposited = BigInt(context.usdcAtomic);
  const observedDelta = after.available && context.redeemableBefore != null
    ? BigInt(after.redeemableAtomic) - BigInt(context.redeemableBefore)
    : null;

  // The floor rises by the amount the confirmed transaction deposited. The
  // observed delta is a verification, not the source of truth: a read taken
  // seconds later also contains accrued interest.
  const floorBefore = BigInt(rule.principalFloorAtomic ?? '0');
  const floorAfter = applyDepositConfirmed(floorBefore, deposited);
  updateRule(rule.id, {
    principalFloorAtomic: floorAfter.toString(),
    principalFloorSource: 'DEPOSIT_CONFIRMED',
  });

  const mismatch = observedDelta !== null && observedDelta * 100n < deposited * 99n;

  const receipt = createReceipt({
    ruleId: rule.id, wallet: rule.wallet, kind: 'DEPOSIT', mode: 'LIVE', status: 'CONFIRMED',
    executionKey: `deposit:${result.signature}`, signature: result.signature, slot: result.slot,
    inputs: { ...context, depositedAtomic: deposited.toString() },
    outputs: {
      floorBefore: floorBefore.toString(),
      floorAfter: floorAfter.toString(),
      redeemableAfter: after.redeemableAtomic ?? null,
      observedDeltaAtomic: observedDelta !== null ? observedDelta.toString() : null,
      deltaVerified: !mismatch,
    },
  });

  return {
    ok: true,
    signature: result.signature,
    floorBefore: floorBefore.toString(),
    floorAfter: floorAfter.toString(),
    observedDeltaAtomic: observedDelta !== null ? observedDelta.toString() : null,
    warning: mismatch
      ? 'The confirmed deposit did not move the position by the expected amount. The floor was raised by the deposited amount; verify the position before harvesting.'
      : null,
    receipt,
  };
}

/* ------------------------------------------------- harvest withdrawal leg -- */

/**
 * Withdraw ONLY the harvestable amount from the vault.
 *
 * Withdrawn USDC is recorded as awaiting a swap. That is deliberately the same
 * bookkeeping used for a failed swap: in both cases USDC has left the vault and
 * has not yet reached its destination, and in both cases the next execution must
 * sweep it before withdrawing anything more.
 */
export async function prepareHarvestWithdrawal({ rule, harvestableAtomicValue }) {
  const vaultAddress = requireVault(rule);
  const solCheck = await requireSolForFees(rule.wallet);
  if (!solCheck.ok) return solCheck;
  const position = await readPosition({ owner: rule.wallet, vaultAddress });
  if (!position.available) return { ok: false, reason: 'KAMINO_UNAVAILABLE', detail: position.detail };

  // Recompute from fresh state; never trust a figure carried in from earlier.
  const buffer = rule.safetyBufferAtomic ?? defaultSafetyBufferAtomic(rule.principalFloorAtomic ?? '0').toString();
  const fresh = harvestableAtomic({
    redeemableAtomic: position.redeemableAtomic,
    principalFloorAtomic: rule.principalFloorAtomic ?? '0',
    safetyBufferAtomic: buffer,
  });
  const requested = harvestableAtomicValue !== undefined ? BigInt(harvestableAtomicValue) : fresh;
  const amount = requested < fresh ? requested : fresh; // never more than is currently harvestable

  if (amount <= 0n) {
    return { ok: false, reason: 'NOTHING_HARVESTABLE', detail: 'no value above the principal floor' };
  }

  // Round DOWN from USDC to shares. This is the decision that protects principal.
  const sharesAtomic = usdcToSharesFloor({
    usdcAtomic: amount,
    shareDecimals: position.shareDecimals,
    exchangeRateScaled: position.exchangeRateScaled,
  });
  if (sharesAtomic <= 0n) return { ok: false, reason: 'AMOUNT_TOO_SMALL', detail: 'rounds to zero vault shares' };

  let w0;
  try {
    w0 = await buildWithdrawInstructions({ owner: rule.wallet, vaultAddress, sharesAtomic, shareDecimals: position.shareDecimals });
  } catch (err) {
    return { ok: false, reason: 'KAMINO_IX_BUILD_FAILED', detail: err.message };
  }
  const { instructions, sharesTokens, groups } = w0;
  const built = await buildUnsignedTransaction({ owner: rule.wallet, instructions });
  if (built.simulation && !built.simulation.ok) {
    return { ok: false, reason: 'SIMULATION_FAILED', detail: JSON.stringify(built.simulation.err), logs: built.simulation.logs };
  }

  const walletUsdcBefore = await usdcBalance(rule.wallet);

  return {
    ok: true,
    stage: 'WITHDRAW',
    transaction: built.transaction,
    simulation: built.simulation,
    context: {
      kind: 'HARVEST_WITHDRAW',
      vaultAddress,
      harvestableAtomic: amount.toString(),
      sharesAtomic: sharesAtomic.toString(),
      sharesTokens,
      groups,
      shareDecimals: position.shareDecimals,
      exchangeRateScaled: position.exchangeRateScaled,
      redeemableBefore: position.redeemableAtomic,
      walletUsdcBefore: walletUsdcBefore.toString(),
      principalFloorAtomic: rule.principalFloorAtomic ?? '0',
      safetyBufferAtomic: buffer,
    },
  };
}

export async function submitHarvestWithdrawal({ rule, signedTransaction, context }) {
  const result = await broadcastAndConfirm(signedTransaction);
  if (!result.ok) {
    createReceipt({
      ruleId: rule.id, wallet: rule.wallet, kind: 'INTEREST', mode: 'LIVE', status: 'FAILED',
      executionKey: `harvest-withdraw:${rule.id}:${Date.now()}`, signature: result.signature ?? null,
      inputs: context, outputs: {}, error: `withdrawal ${result.reason}: ${result.detail}`,
    });
    return { ok: false, reason: result.reason, detail: result.detail };
  }

  // Measure what actually arrived rather than assuming the requested amount.
  const walletUsdcAfter = await usdcBalance(rule.wallet);
  const received = walletUsdcAfter - BigInt(context.walletUsdcBefore);
  const credited = received > 0n ? received : BigInt(context.harvestableAtomic);

  // The floor does not move on a harvest. Verify the position still covers it.
  const after = await readPosition({ owner: rule.wallet, vaultAddress: context.vaultAddress });
  const floorCheck = after.available
    ? verifyFloorStillCovered({
        principalFloorAtomic: rule.principalFloorAtomic ?? '0',
        redeemableAtomicAfter: after.redeemableAtomic,
      })
    : { ok: true, unverified: true };

  recordStranded({
    ruleId: rule.id, wallet: rule.wallet, mint: USDC_MINT,
    rawAtomic: credited.toString(), origin: 'WITHDRAWN_AWAITING_SWAP',
  });

  return {
    ok: true,
    signature: result.signature,
    slot: result.slot,
    withdrawnAtomic: credited.toString(),
    observedWalletDelta: received.toString(),
    floorUnchanged: rule.principalFloorAtomic ?? '0',
    floorStillCovered: floorCheck.ok,
    floorWarning: floorCheck.ok ? null : `Position no longer covers the principal floor (short ${floorCheck.shortfallAtomic}).`,
    nextStage: 'SWAP',
  };
}

/* --------------------------------------------------- principal withdrawal -- */

export async function preparePrincipalWithdrawal({ rule, requestedAtomic }) {
  const vaultAddress = requireVault(rule);
  const solCheck = await requireSolForFees(rule.wallet);
  if (!solCheck.ok) return solCheck;
  const position = await readPosition({ owner: rule.wallet, vaultAddress });
  if (!position.available) return { ok: false, reason: 'KAMINO_UNAVAILABLE', detail: position.detail };

  const floor = BigInt(rule.principalFloorAtomic ?? '0');
  if (floor <= 0n) return { ok: false, reason: 'NO_PRINCIPAL_FLOOR', detail: 'this rule has no stored principal floor' };

  const plan = principalWithdrawalPlan({
    principalFloorAtomic: floor,
    redeemableAtomic: position.redeemableAtomic,
  });

  // Honour a partial request, but never more than the floor or than is redeemable.
  let amount = BigInt(plan.withdrawableAtomic);
  if (requestedAtomic !== undefined && requestedAtomic !== null) {
    const asked = BigInt(requestedAtomic);
    if (asked <= 0n) return { ok: false, reason: 'INVALID_AMOUNT' };
    amount = asked < amount ? asked : amount;
  }
  if (amount <= 0n) {
    return { ok: false, reason: 'NOTHING_REDEEMABLE', detail: 'the vault position has no redeemable value', plan };
  }

  const sharesAtomic = usdcToSharesFloor({
    usdcAtomic: amount,
    shareDecimals: position.shareDecimals,
    exchangeRateScaled: position.exchangeRateScaled,
  });
  if (sharesAtomic <= 0n) return { ok: false, reason: 'AMOUNT_TOO_SMALL', detail: 'rounds to zero vault shares' };

  let p0;
  try {
    p0 = await buildWithdrawInstructions({ owner: rule.wallet, vaultAddress, sharesAtomic, shareDecimals: position.shareDecimals });
  } catch (err) {
    return { ok: false, reason: 'KAMINO_IX_BUILD_FAILED', detail: err.message };
  }
  const { instructions, sharesTokens, groups } = p0;
  const built = await buildUnsignedTransaction({ owner: rule.wallet, instructions });
  if (built.simulation && !built.simulation.ok) {
    return { ok: false, reason: 'SIMULATION_FAILED', detail: JSON.stringify(built.simulation.err), logs: built.simulation.logs };
  }

  const walletUsdcBefore = await usdcBalance(rule.wallet);

  return {
    ok: true,
    stage: 'PRINCIPAL_WITHDRAW',
    transaction: built.transaction,
    simulation: built.simulation,
    // Surfaced verbatim so the UI cannot quietly present an impaired position
    // as a full return.
    plan: {
      ...plan,
      impaired: !plan.fullyReturnable,
      shortfallAtomic: plan.shortfallAtomic,
      redeemableAtomic: position.redeemableAtomic,
    },
    context: {
      kind: 'PRINCIPAL_WITHDRAW',
      vaultAddress,
      requestedAtomic: amount.toString(),
      sharesAtomic: sharesAtomic.toString(),
      sharesTokens,
      groups,
      shareDecimals: position.shareDecimals,
      exchangeRateScaled: position.exchangeRateScaled,
      floorBefore: floor.toString(),
      redeemableBefore: position.redeemableAtomic,
      shortfallAtomic: plan.shortfallAtomic,
      fullyReturnable: plan.fullyReturnable,
      walletUsdcBefore: walletUsdcBefore.toString(),
    },
  };
}

export async function submitPrincipalWithdrawal({ rule, signedTransaction, context }) {
  const result = await broadcastAndConfirm(signedTransaction);
  if (!result.ok) {
    createReceipt({
      ruleId: rule.id, wallet: rule.wallet, kind: 'PRINCIPAL_WITHDRAW', mode: 'LIVE', status: 'FAILED',
      executionKey: `principal-withdraw:${rule.id}:${Date.now()}`, signature: result.signature ?? null,
      inputs: context, outputs: {}, error: `${result.reason}: ${result.detail}`,
    });
    // Nothing confirmed, so the floor does not move.
    return { ok: false, reason: result.reason, detail: result.detail };
  }

  const walletUsdcAfter = await usdcBalance(rule.wallet);
  const received = walletUsdcAfter - BigInt(context.walletUsdcBefore);
  const returned = received > 0n ? received : BigInt(context.requestedAtomic);

  const floorBefore = BigInt(context.floorBefore);
  const floorAfter = applyPrincipalWithdrawConfirmed(floorBefore, returned);
  updateRule(rule.id, { principalFloorAtomic: floorAfter.toString() });

  const after = await readPosition({ owner: rule.wallet, vaultAddress: context.vaultAddress });

  const receipt = createReceipt({
    ruleId: rule.id, wallet: rule.wallet, kind: 'PRINCIPAL_WITHDRAW', mode: 'LIVE', status: 'CONFIRMED',
    executionKey: `principal-withdraw:${result.signature}`, signature: result.signature, slot: result.slot,
    inputs: context,
    outputs: {
      returnedAtomic: returned.toString(),
      observedWalletDelta: received.toString(),
      floorBefore: floorBefore.toString(),
      floorAfter: floorAfter.toString(),
      redeemableAfter: after.redeemableAtomic ?? null,
      shortfallAtomic: context.shortfallAtomic,
      fullyReturnable: context.fullyReturnable,
    },
  });

  return {
    ok: true,
    signature: result.signature,
    returnedAtomic: returned.toString(),
    floorBefore: floorBefore.toString(),
    floorAfter: floorAfter.toString(),
    shortfallAtomic: context.shortfallAtomic,
    fullyReturnable: context.fullyReturnable,
    // Stated plainly rather than implied: equities bought from earnings are a
    // separate holding and are never touched by a principal withdrawal.
    equityHoldingsUntouched: true,
    receipt,
  };
}

/** USDC already out of the vault and awaiting a swap, for the sweep-first rule. */
export function pendingSwapFunds(ruleId) {
  const total = totalStrandedAtomic(ruleId, USDC_MINT);
  return { totalAtomic: total.toString(), entries: listStranded(ruleId) };
}

export { USDC_DECIMALS };
