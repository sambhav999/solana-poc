/**
 * Execution: prepare -> (browser signs) -> submit.
 *
 * The backend never holds a key. It builds an unsigned transaction via Jupiter,
 * hands it to the browser, and the wallet signs. Only after Jupiter reports a
 * confirmed transaction does a CONFIRMED receipt exist.
 *
 * Failure rule: a quote is not a spend. Nothing is marked executed because a
 * route existed, only because a signature confirmed.
 */
import { getOrder, executeOrder } from '../adapters/jupiter/client.js';
import { applyQuoteGuards } from '../core/ruleEngine.js';
import { STATUS } from '../core/ruleEngine.js';
import { createReceipt, hasConfirmedExecution } from '../db/receipts.js';
import { markSnapshotProcessed } from '../db/snapshots.js';
import { recordStranded } from '../db/stranded.js';
import { getSolBalanceLamports, getTokenBalance, USDC_MINT, transactionMessageHash } from '../adapters/solana/rpc.js';
import { createIntent, getIntent, consumeIntent } from '../db/intents.js';
import { verifyDividendExecution, verifyInterestExecution, VERIFICATION } from './verify.js';
import { refreshBaselines } from './drift.js';
import { runFirewall } from './firewall.js';
import { evaluateRule } from './evaluate.js';
import { prepareHarvestWithdrawal, pendingSwapFunds } from './kaminoFlows.js';
import { markSwept } from '../db/stranded.js';

/** A firewall block: a normal, expected outcome -- not an error. */
function firewallBlocked(fw, evaluation, consequence) {
  return {
    ok: false,
    reason: 'FIREWALL_BLOCKED',
    blocked: true,
    detail: `${fw.reason} ${consequence}`,
    firewall: {
      decision: fw.decision, breach: fw.breach, reason: fw.reason,
      premiumBps: fw.premiumBps ?? null, maxPremiumBps: fw.maxPremiumBps ?? null,
      minPremiumBps: fw.minPremiumBps ?? null, tokenPriceUsd: fw.tokenPriceUsd ?? null,
      referencePriceUsd: fw.referencePriceUsd ?? null, tokenSource: fw.tokenSource ?? null,
      referenceSource: fw.referenceSource ?? null, decisionId: fw.decisionId ?? null,
      earningsUsdAtomic: fw.earningsUsdAtomic ?? null,
    },
    evaluation,
  };
}

/** Enough SOL to sign and to open any missing token account. */
const MIN_SOL_LAMPORTS = 3_000_000n; // 0.003 SOL

/**
 * Step 1. Re-evaluate from scratch, guard the live quote, and return an unsigned
 * transaction. Nothing is persisted as executed here.
 */
export async function prepareExecution(rule) {
  const evaluation = await evaluateRule(rule);
  if (evaluation.status !== STATUS.READY) {
    return { ok: false, reason: 'NOT_READY', detail: evaluation.reason, evaluation };
  }
  if (hasConfirmedExecution(evaluation.executionKey)) {
    return { ok: false, reason: 'ALREADY_EXECUTED', detail: 'An execution for this event has already confirmed.', evaluation };
  }

  // The user must be able to pay for the transaction.
  const sol = await getSolBalanceLamports(rule.wallet).catch(() => null);
  if (sol !== null && sol < MIN_SOL_LAMPORTS) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_SOL',
      detail: `Wallet holds ${Number(sol) / 1e9} SOL. At least ${Number(MIN_SOL_LAMPORTS) / 1e9} SOL is needed for fees and any token-account rent.`,
      evaluation,
    };
  }

  /*
   * INTEREST rules move value out of the vault BEFORE swapping, so a harvest is
   * a two-signature flow:
   *
   *   stage WITHDRAW -> Kamino withdrawal of exactly the harvestable amount
   *   stage SWAP     -> Jupiter swap of the USDC now sitting in the wallet
   *
   * Anything already withdrawn but not yet swapped -- from this flow or from an
   * earlier failed swap -- is swept FIRST, so a retry never withdraws on top of
   * USDC that is already out.
   */
  if (rule.sourceType === 'KAMINO_USDC') {
    const pending = pendingSwapFunds(rule.id);
    const pendingAtomic = BigInt(pending.totalAtomic);

    if (pendingAtomic <= 0n) {
      /*
       * Capital Firewall FIRST. If it blocks, nothing is withdrawn: the earnings
       * stay in the vault, untouched. Checking after the withdrawal would leave
       * them stranded in the wallet as loose USDC.
       */
      const fw = await runFirewall({
        rule,
        amountAtomic: evaluation.harvestableAtomic,
        inputMint: USDC_MINT,
        intentKey: evaluation.executionKey,
      });
      if (fw.decision === 'BLOCK') {
        return firewallBlocked(fw, evaluation, 'Earnings were not withdrawn from Kamino; they remain in the vault.');
      }
      evaluation.firewall = fw;

      const withdrawal = await prepareHarvestWithdrawal({
        rule,
        harvestableAtomicValue: evaluation.harvestableAtomic,
      });
      if (!withdrawal.ok) {
        return { ok: false, reason: withdrawal.reason, detail: withdrawal.detail, evaluation };
      }
      return {
        ok: true,
        stage: 'WITHDRAW',
        transaction: withdrawal.transaction,
        simulation: withdrawal.simulation,
        context: withdrawal.context,
        evaluation,
        note: 'Step 1 of 2: withdraw earnings from Kamino. The swap is signed separately once this confirms.',
      };
    }

    // Funds are already out of the vault: swap exactly those, sweeping first.
    const walletUsdc = BigInt((await getTokenBalance({ owner: rule.wallet, mint: USDC_MINT }).catch(() => ({ rawAtomic: '0' }))).rawAtomic);
    const swapAmount = pendingAtomic < walletUsdc ? pendingAtomic : walletUsdc;
    if (swapAmount <= 0n) {
      return {
        ok: false,
        reason: 'WITHDRAWN_FUNDS_MISSING',
        detail: `${pendingAtomic} atomic USDC is recorded as withdrawn but the wallet holds ${walletUsdc}.`,
        evaluation,
      };
    }
    evaluation.intent = { ...evaluation.intent, inputMint: USDC_MINT, inputRawAtomic: swapAmount.toString() };
    evaluation.sweptEntries = pending.entries.map((e) => e.id);
    evaluation.stage = 'SWAP';
  }

  // For a dividend rule the source balance must still be there, in full.
  if (rule.sourceType === 'XSTOCK_DIVIDEND') {
    const bal = await getTokenBalance({ owner: rule.wallet, mint: rule.sourceMint });
    if (BigInt(bal.rawAtomic) < BigInt(evaluation.intent.inputRawAtomic)) {
      return { ok: false, reason: 'INSUFFICIENT_SOURCE_BALANCE', detail: `wallet holds ${bal.rawAtomic} raw units`, evaluation };
    }
  }

  // Fresh order WITH a taker, so a signable transaction comes back.
  let order;
  try {
    order = await getOrder({
      inputMint: evaluation.intent.inputMint,
      outputMint: evaluation.intent.outputMint,
      amountRawAtomic: evaluation.intent.inputRawAtomic,
      taker: rule.wallet,
      slippageBps: evaluation.intent.maxSlippageBps,
    });
  } catch (err) {
    return { ok: false, reason: 'NO_ROUTE', detail: err.message, evaluation };
  }

  // Capital Firewall against the EXACT quote the user is about to sign.
  const fw = await runFirewall({
    rule,
    amountAtomic: evaluation.intent.inputRawAtomic,
    inputMint: evaluation.intent.inputMint,
    intentKey: evaluation.executionKey,
    quote: order,
  });
  if (fw.decision === 'BLOCK') {
    return firewallBlocked(fw, evaluation, rule.sourceType === 'KAMINO_USDC'
      ? 'The withdrawn USDC stays in your wallet, recorded for the next attempt.'
      : 'No source tokens were sold; the dividend remains unrouted.');
  }
  evaluation.firewall = fw;

  const guard = applyQuoteGuards({ evaluation, quote: order, rule });
  if (!guard.ok) {
    return { ok: false, reason: guard.reason, detail: guard.detail, evaluation, quote: order };
  }
  if (!order.transaction) {
    return { ok: false, reason: 'NO_TRANSACTION', detail: 'Jupiter returned no signable transaction for this taker.', evaluation, quote: order };
  }

  // Record exactly what the server authorised, including the hash of the message
  // it built. Anything the wallet sends back is checked against this.
  const intent = createIntent({
    ruleId: rule.id,
    wallet: rule.wallet,
    kind: rule.earningsType,
    stage: 'SWAP',
    executionKey: evaluation.executionKey,
    messageHash: transactionMessageHash(order.transaction),
    jupiterRequestId: order.requestId,
    authorisedRaw: evaluation.intent.inputRawAtomic,
    sourceMint: evaluation.intent.inputMint,
    destinationMint: evaluation.intent.outputMint,
    snapshot: {
      rawBalanceAtomic: evaluation.snapshot?.rawBalanceAtomic ?? null,
      multiplierBefore: evaluation.snapshot?.multiplierBefore ?? null,
      multiplierAfter: evaluation.snapshot?.multiplierAfter ?? null,
      snapshotId: evaluation.snapshot?.id ?? null,
      principalFloorAtomic: rule.principalFloorAtomic ?? null,
      vaultAddress: rule.kaminoVault ?? null,
      sweptEntries: evaluation.sweptEntries ?? [],
    },
  });

  return {
    ok: true,
    stage: evaluation.stage ?? 'SWAP',
    evaluation,
    quote: order,
    transaction: order.transaction,
    requestId: order.requestId,
    executionKey: evaluation.executionKey,
    intentId: intent.id,
    guard,
  };
}

/**
 * Step 2. Submit the signed transaction and record the outcome.
 *
 * `context` carries the evaluation the user actually approved, so the receipt
 * stores the inputs the decision was made on rather than a fresh re-read.
 */
export async function submitExecution({ rule, signedTransactionBase64, requestId, executionKey, context, intentId }) {
  if (hasConfirmedExecution(executionKey)) {
    return { ok: false, reason: 'ALREADY_EXECUTED' };
  }

  /*
   * Server-side binding. The browser signs, so without these checks a wallet
   * (or anything sitting between it and us) could return a DIFFERENT transaction
   * and we would broadcast it.
   *
   *   - the signed message must hash to the message we prepared;
   *   - the Jupiter requestId must be the one bound to this intent.
   *
   * Signatures are excluded from the hash, so signing does not change it.
   */
  /*
   * Binding is FAIL-CLOSED. A missing or unknown intent is refused rather than
   * waved through: skipping the check when the reference is absent would let
   * anyone bypass it simply by omitting the field.
   */
  const intent = intentId ? getIntent(intentId) : null;
  if (!intentId) {
    return {
      ok: false,
      reason: 'INTENT_REQUIRED',
      detail: 'No execution intent supplied. Prepare the execution again; nothing was broadcast.',
    };
  }
  if (!intent) {
    return {
      ok: false,
      reason: 'INTENT_NOT_FOUND',
      detail: 'The referenced execution intent does not exist. Nothing was broadcast.',
    };
  }
  {
    if (intent.status !== 'OPEN') {
      return { ok: false, reason: 'INTENT_NOT_OPEN', detail: `intent is ${intent.status}` };
    }
    if (intent.ruleId !== rule.id || intent.wallet !== rule.wallet) {
      return { ok: false, reason: 'INTENT_MISMATCH', detail: 'intent does not belong to this rule and wallet' };
    }
    if (intent.jupiterRequestId && String(requestId) !== String(intent.jupiterRequestId)) {
      return {
        ok: false,
        reason: 'REQUEST_ID_MISMATCH',
        detail: 'the submitted Jupiter requestId is not the one authorised for this execution',
      };
    }
    let signedHash;
    try {
      signedHash = transactionMessageHash(signedTransactionBase64);
    } catch (err) {
      return { ok: false, reason: 'UNREADABLE_TRANSACTION', detail: err.message };
    }
    if (intent.messageHash && signedHash !== intent.messageHash) {
      return {
        ok: false,
        reason: 'SIGNED_MESSAGE_MISMATCH',
        detail: 'The signed transaction is not the transaction Overflow prepared. Nothing was broadcast.',
        expected: intent.messageHash,
        received: signedHash,
      };
    }
  }

  let result;
  try {
    result = await executeOrder({ signedTransactionBase64, requestId });
  } catch (err) {
    createReceipt({
      ruleId: rule.id, wallet: rule.wallet, kind: rule.earningsType, mode: 'LIVE',
      status: 'FAILED', executionKey, inputs: context?.inputs ?? {}, outputs: {},
      quote: context?.quote ?? null, error: err.message,
      verification: VERIFICATION.FAILED, verificationNote: `Execution call failed: ${err.message}`,
      preserved: false, intentId: intent?.id ?? null,
    });
    return { ok: false, reason: 'EXECUTE_FAILED', detail: err.message };
  }

  if (!result.ok) {
    // The interest rule withdraws from Kamino before swapping, so a failed swap
    // can leave USDC in the wallet. Record it so the next run sweeps it.
    if (rule.earningsType === 'INTEREST' && context?.intent?.inputRawAtomic && !context?.sweptEntries?.length) {
      recordStranded({
        ruleId: rule.id, wallet: rule.wallet, mint: context.intent.inputMint,
        rawAtomic: context.intent.inputRawAtomic, origin: 'FAILED_SWAP_AFTER_WITHDRAW',
      });
    }
    const receipt = createReceipt({
      ruleId: rule.id, wallet: rule.wallet, kind: rule.earningsType, mode: 'LIVE',
      status: rule.earningsType === 'INTEREST' ? 'PARTIAL' : 'FAILED',
      executionKey, signature: result.signature, slot: result.slot,
      inputs: context?.inputs ?? {}, outputs: { jupiterStatus: result.status, code: result.code },
      quote: context?.quote ?? null, error: result.error || `Jupiter status ${result.status}`,
      verification: VERIFICATION.FAILED,
      verificationNote: `Transaction did not confirm: ${result.error || result.status}`,
      preserved: false, intentId: intent?.id ?? null,
    });
    /*
     * The event is deliberately NOT marked processed here. A failed attempt must
     * leave the earnings routable, or a transient failure would silently cost the
     * user that dividend forever.
     */
    return { ok: false, reason: 'NOT_CONFIRMED', detail: result.error || result.status, receipt };
  }

  // Confirmed. Now prove it from the chain rather than trusting the response.
  const snapshot = intent?.snapshot ?? {};
  let verification;
  try {
    verification = rule.sourceType === 'XSTOCK_DIVIDEND'
      ? await verifyDividendExecution({
          signature: result.signature,
          wallet: rule.wallet,
          sourceMint: rule.sourceMint,
          sourceSymbol: rule.sourceSymbol ?? rule.sourceId,
          destinationMint: rule.destinationMint,
          destinationSymbol: rule.destinationSymbol,
          snapshot: {
            rawBalanceAtomic: snapshot.rawBalanceAtomic ?? context?.inputs?.rawBalanceAtomic ?? '0',
            multiplierBefore: snapshot.multiplierBefore ?? context?.inputs?.multiplierBefore ?? '1',
            multiplierAfter: snapshot.multiplierAfter ?? context?.inputs?.multiplierAfter ?? '1',
          },
          authorisedRaw: intent?.authorisedRaw ?? context?.intent?.inputRawAtomic ?? '0',
        })
      : await verifyInterestExecution({
          signature: result.signature,
          wallet: rule.wallet,
          vaultAddress: snapshot.vaultAddress ?? rule.kaminoVault,
          destinationMint: rule.destinationMint,
          destinationSymbol: rule.destinationSymbol,
          principalFloorAtomic: snapshot.principalFloorAtomic ?? rule.principalFloorAtomic ?? '0',
          authorisedRaw: intent?.authorisedRaw ?? context?.intent?.inputRawAtomic ?? '0',
          withdrawnRaw: intent?.withdrawnRaw ?? null,
        });
  } catch (err) {
    verification = {
      verification: VERIFICATION.UNVERIFIED,
      preserved: null,
      note: `Settlement verification could not complete: ${err.message}`,
      proofs: {},
    };
  }

  const receipt = createReceipt({
    ruleId: rule.id,
    wallet: rule.wallet,
    kind: rule.earningsType,
    mode: 'LIVE',
    // Delivery succeeded; whether it is PROVEN is a separate axis.
    status: 'CONFIRMED',
    executionKey,
    signature: result.signature,
    slot: result.slot,
    inputs: context?.inputs ?? {},
    outputs: {
      jupiterStatus: result.status,
      inputAmountResult: result.inputAmountResult,
      outputAmountResult: result.outputAmountResult,
      ...verification,
    },
    quote: context?.quote ?? null,
    verification: verification.verification,
    verificationNote: verification.note,
    preserved: verification.preserved,
    proofs: verification.proofs,
    intentId: intent?.id ?? null,
    destinationCategory: rule.destinationCategory ?? 'PUBLIC_STOCK',
    destinationSymbol: rule.destinationSymbol,
    earningsUsdAtomic: context?.firewall?.earningsUsdAtomic
      ?? (rule.sourceType === 'KAMINO_USDC' ? (intent?.authorisedRaw ?? null) : null),
  });

  // Only a settled, non-contradicted execution closes out the event.
  if (rule.sourceType === 'XSTOCK_DIVIDEND' && verification.verification !== VERIFICATION.FAILED) {
    const snapshotId = context?.snapshotId ?? snapshot.snapshotId;
    if (snapshotId) markSnapshotProcessed(snapshotId);
  }
  if (context?.sweptEntries?.length) markSwept(context.sweptEntries);
  if (intent) consumeIntent(intent.id);

  // Re-baseline so the new, post-trade position is what drift is measured against.
  await refreshBaselines(rule).catch(() => {});

  return { ok: true, receipt, signature: result.signature, verification: verification.verification };
}
