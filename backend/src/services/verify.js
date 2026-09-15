/**
 * Post-settlement verification.
 *
 * A receipt is not proof because a swap API said "Success". It is proof because
 * the chain says so. After settlement this re-reads state and requires THREE
 * independent facts, all from the specific transaction that was signed:
 *
 *   1. the source-token spend equals EXACTLY the amount Overflow authorised;
 *   2. the destination token actually increased in that same transaction;
 *   3. the preservation invariant still holds on OBSERVED balances.
 *
 * Outcomes:
 *   VERIFIED_ON_CHAIN  all three proven
 *   UNVERIFIED         invariant holds, but a proof was unavailable
 *   FAILED             the invariant broke, or an observed amount contradicts
 *                      what was authorised
 *
 * A receipt is allowed to fail. That is the point: an assertion that always says
 * "preserved: true" proves nothing at all.
 */
import { tokenDeltaFromTransaction, getTokenBalance, getMintInfo } from '../adapters/solana/rpc.js';
import { fetchMultiplier } from '../adapters/xstocks/client.js';
import { readPosition } from '../adapters/kamino/vault.js';
import { mulScaled, parseDecimalToScaled, rawToScaled, formatScaled } from '../core/units.js';

export const VERIFICATION = {
  VERIFIED: 'VERIFIED_ON_CHAIN',
  UNVERIFIED: 'UNVERIFIED',
  FAILED: 'FAILED',
};

/** Did this transaction spend exactly what we authorised, and nothing more? */
async function exactSpendProof({ signature, wallet, mint, authorisedRaw }) {
  const expected = -BigInt(authorisedRaw); // a spend is a negative delta
  const observed = await tokenDeltaFromTransaction({ signature, owner: wallet, mint }).catch(() => null);
  if (!observed) return { available: false, exact: false, actual: null, expected };
  return { available: true, exact: observed.delta === expected, actual: observed.delta, expected };
}

/** Did the destination token actually increase in this transaction? */
async function destinationProof({ signature, wallet, mint }) {
  const observed = await tokenDeltaFromTransaction({ signature, owner: wallet, mint }).catch(() => null);
  if (!observed) return { available: false, received: null };
  return { available: observed.delta > 0n, received: observed.delta > 0n ? observed.delta.toString() : null };
}

/**
 * Exposure comparison on OBSERVED balances: raw read back from chain, multiplied
 * by the multiplier read back from chain. Nothing is assumed from the snapshot
 * except what the user held before.
 */
function exposure(rawAtomic, decimals, multiplier) {
  return mulScaled(rawToScaled(BigInt(rawAtomic), decimals), parseDecimalToScaled(multiplier));
}

export async function verifyDividendExecution({ signature, wallet, sourceMint, sourceSymbol, destinationMint, destinationSymbol, snapshot, authorisedRaw }) {
  const [spend, dest, after, mintInfo] = await Promise.all([
    exactSpendProof({ signature, wallet, mint: sourceMint, authorisedRaw }),
    destinationProof({ signature, wallet, mint: destinationMint }),
    getTokenBalance({ owner: wallet, mint: sourceMint }).catch(() => null),
    getMintInfo(sourceMint).catch(() => null),
  ]);

  // The live multiplier after settlement, preferring the chain over the API.
  let multiplierAfter = mintInfo?.effectiveMultiplier ?? null;
  let multiplierProven = Boolean(multiplierAfter);
  if (!multiplierAfter) {
    const api = await fetchMultiplier(sourceSymbol).catch(() => null);
    multiplierAfter = api?.currentMultiplier ?? snapshot.multiplierAfter;
    multiplierProven = Boolean(api?.currentMultiplier);
  }

  const decimals = after?.decimals ?? mintInfo?.decimals ?? 8;
  const exposureBefore = exposure(snapshot.rawBalanceAtomic, decimals, snapshot.multiplierBefore);
  const exposureAfter = after ? exposure(after.rawAtomic, decimals, multiplierAfter) : null;
  const preserved = exposureAfter !== null && exposureAfter >= exposureBefore;

  const contradicted = (spend.available && !spend.exact) || (exposureAfter !== null && !preserved);
  const verification = contradicted
    ? VERIFICATION.FAILED
    : (preserved && spend.exact && dest.available && multiplierProven)
      ? VERIFICATION.VERIFIED
      : VERIFICATION.UNVERIFIED;

  return {
    verification,
    preserved,
    signature,
    sourceBeforeRaw: String(snapshot.rawBalanceAtomic),
    sourceAfterRaw: after?.rawAtomic ?? null,
    routedRaw: String(authorisedRaw),
    destinationReceivedRaw: dest.received,
    exposureBefore: formatScaled(exposureBefore, decimals),
    exposureAfter: exposureAfter === null ? null : formatScaled(exposureAfter, decimals),
    multiplierAfter,
    proofs: {
      exactSourceSpend: spend.exact,
      sourceSpendAvailable: spend.available,
      observedSourceDelta: spend.actual === null ? null : spend.actual.toString(),
      authorisedSourceDelta: spend.expected.toString(),
      destinationIncreased: dest.available,
      multiplierReRead: multiplierProven,
      exposurePreserved: preserved,
    },
    note: dividendNote({ preserved, spend, dest, multiplierProven, exposureBefore, exposureAfter, decimals, sourceSymbol, destinationSymbol }),
  };
}

function dividendNote({ preserved, spend, dest, multiplierProven, exposureBefore, exposureAfter, decimals, sourceSymbol, destinationSymbol }) {
  if (exposureAfter !== null && !preserved) {
    return `Exposure fell from ${formatScaled(exposureBefore, decimals)} to ${formatScaled(exposureAfter, decimals)} ${sourceSymbol}. Do not reuse this rule until it is reviewed.`;
  }
  if (spend.available && !spend.exact) {
    return `Source-token delta ${spend.actual} did not equal the authorised spend ${spend.expected}.`;
  }
  if (!spend.available) return 'Exposure is preserved, but the exact source spend could not be read from transaction metadata.';
  if (!dest.available) return `Source spend is correct, but no ${destinationSymbol} increase could be proven from this transaction.`;
  if (!multiplierProven) return 'Balances are correct, but the live multiplier could not be re-read after settlement.';
  return `Pre-dividend exposure ${formatScaled(exposureBefore, decimals)} ${sourceSymbol} remains covered; exact source spend and ${destinationSymbol} receipt were both proven from this transaction.`;
}

export async function verifyInterestExecution({ signature, wallet, vaultAddress, destinationMint, destinationSymbol, principalFloorAtomic, authorisedRaw, withdrawnRaw }) {
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const [spend, dest, position] = await Promise.all([
    exactSpendProof({ signature, wallet, mint: USDC_MINT, authorisedRaw }),
    destinationProof({ signature, wallet, mint: destinationMint }),
    readPosition({ owner: wallet, vaultAddress }).catch(() => null),
  ]);

  const floor = BigInt(principalFloorAtomic ?? '0');
  const redeemableAfter = position?.available ? BigInt(position.redeemableAtomic) : null;
  const preserved = redeemableAfter !== null && redeemableAfter >= floor;

  const contradicted = (spend.available && !spend.exact) || (redeemableAfter !== null && !preserved);
  const verification = contradicted
    ? VERIFICATION.FAILED
    : (preserved && spend.exact && dest.available)
      ? VERIFICATION.VERIFIED
      : VERIFICATION.UNVERIFIED;

  return {
    verification,
    preserved,
    signature,
    principalFloorAtomic: floor.toString(),
    redeemableAfterAtomic: redeemableAfter === null ? null : redeemableAfter.toString(),
    routedRaw: String(authorisedRaw),
    withdrawnRaw: withdrawnRaw ? String(withdrawnRaw) : null,
    destinationReceivedRaw: dest.received,
    proofs: {
      exactSourceSpend: spend.exact,
      sourceSpendAvailable: spend.available,
      observedSourceDelta: spend.actual === null ? null : spend.actual.toString(),
      authorisedSourceDelta: spend.expected.toString(),
      destinationIncreased: dest.available,
      floorStillCovered: preserved,
    },
    note: interestNote({ preserved, spend, dest, floor, redeemableAfter, destinationSymbol }),
  };
}

function interestNote({ preserved, spend, dest, floor, redeemableAfter, destinationSymbol }) {
  const usd = (v) => `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0').slice(0, 2)}`;
  if (redeemableAfter !== null && !preserved) {
    return `Position fell to ${usd(redeemableAfter)} USDC, below the ${usd(floor)} USDC floor. Principal may have been spent.`;
  }
  if (spend.available && !spend.exact) {
    return `Principal floor remains covered, but the swap spent ${spend.actual} rather than the authorised ${spend.expected}.`;
  }
  if (!spend.available) return 'Principal floor remains covered, but the exact swap input could not be read from transaction metadata.';
  if (!dest.available) return `Swap input is correct, but no ${destinationSymbol} increase could be proven from this transaction.`;
  return `Principal floor ${usd(floor)} USDC remains covered; exact swap input and ${destinationSymbol} receipt were both proven from this transaction.`;
}
