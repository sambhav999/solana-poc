/**
 * Evaluation service: gather fresh state, run the engine, return a decision.
 * Nothing here signs or sends. The result is an intent the execution layer may
 * act on, and every guard is re-run at execution time against fresh data.
 */
import { evaluateDividendRule, evaluateInterestRule, STATUS } from '../core/ruleEngine.js';
import { getOpenSnapshotForRule } from '../db/snapshots.js';
import { hasConfirmedExecution } from '../db/receipts.js';
import { getAsset, getAssetDetail } from './assets.js';
import { fetchMultiplier } from '../adapters/xstocks/client.js';
import { getTokenBalance, crossCheckMultiplier, getSlot } from '../adapters/solana/rpc.js';
import { readPosition } from '../adapters/kamino/vault.js';
import { getOrder } from '../adapters/jupiter/client.js';
import { parseDecimalToScaled } from '../core/units.js';
import { checkDividendBaseline, checkVaultBaseline, pauseForDrift } from './drift.js';

export async function evaluateRule(rule) {
  if (rule.status !== 'ACTIVE') {
    return {
      status: STATUS.BLOCKED,
      reason: rule.pauseReason
        ? rule.pauseReason.split(': ').slice(1).join(': ') || rule.pauseReason
        : 'Rule is paused.',
      pauseReason: rule.pauseReason ?? null,
      needsBaselineReconfirm: Boolean(rule.pauseReason),
      guards: {},
      ruleId: rule.id,
    };
  }

  /*
   * Drift check before anything else. If the position moved outside Overflow,
   * the stored baseline no longer describes reality and every downstream number
   * would be computed against a position we no longer understand. Pause instead.
   */
  const drift = rule.sourceType === 'XSTOCK_DIVIDEND'
    ? await checkDividendBaseline(rule).catch(() => ({ ok: true, unverified: true }))
    : await checkVaultBaseline(rule).catch(() => ({ ok: true, unverified: true }));

  if (!drift.ok) {
    pauseForDrift(rule.id, drift.reason, drift.detail);
    return {
      status: STATUS.NEEDS_REVIEW,
      reason: drift.detail,
      pauseReason: `${drift.reason}: ${drift.detail}`,
      needsBaselineReconfirm: true,
      drift: { baseline: drift.baseline, observed: drift.observed },
      guards: { baselineIntact: false },
      ruleId: rule.id,
    };
  }
  const result = rule.sourceType === 'XSTOCK_DIVIDEND'
    ? await evaluateDividend(rule)
    : await evaluateInterest(rule);
  return {
    ...result,
    guards: { ...(result.guards ?? {}), baselineIntact: true },
    ruleId: rule.id,
    evaluatedAt: new Date().toISOString(),
  };
}

async function evaluateDividend(rule) {
  const snapshot = getOpenSnapshotForRule(rule.id);
  const asset = await getAsset(rule.sourceSymbol ?? rule.sourceId);

  if (!snapshot) {
    // Nothing pending. Report the current multiplier so the UI can show the rule
    // is armed and watching rather than broken.
    const live = await fetchMultiplier(rule.sourceSymbol ?? rule.sourceId).catch(() => null);
    return {
      status: STATUS.WAITING,
      reason: 'Armed. No dividend event pending for this asset.',
      guards: { eventType: false, activationSafe: false, sourcePreserved: false, threshold: false, idempotent: true, balanceUnchanged: true },
      currentMultiplier: live?.currentMultiplier ?? null,
    };
  }

  const [balance, multiplier] = await Promise.all([
    getTokenBalance({ owner: rule.wallet, mint: rule.sourceMint }).catch(() => ({ rawAtomic: '0' })),
    fetchMultiplier(rule.sourceSymbol ?? rule.sourceId).catch(() => null),
  ]);

  const alreadyExecuted = snapshot.processed;
  const evaluation = evaluateDividendRule({
    rule,
    snapshot,
    live: { rawBalanceAtomic: balance.rawAtomic, currentMultiplier: multiplier?.currentMultiplier },
    asset,
    priceUsdScaled: null,
    allowOvernight: rule.allowOvernight,
    alreadyExecuted,
  });

  // Chain is authoritative: verify the multiplier we are about to act on.
  if (evaluation.status === STATUS.READY) {
    const check = await crossCheckMultiplier({ mint: rule.sourceMint, apiMultiplier: snapshot.multiplierAfter });
    evaluation.multiplierCrossCheck = check;
    if (check.checked && !check.matches) {
      return {
        ...evaluation,
        status: STATUS.NEEDS_REVIEW,
        reason: `On-chain multiplier ${check.onchain} does not match the API value ${check.api} recorded for this event.`,
      };
    }
    if (evaluation.executionKey && hasConfirmedExecution(evaluation.executionKey)) {
      return { ...evaluation, status: STATUS.BLOCKED, reason: 'Already executed for this corporate action.' };
    }
    // Attach a live quote so the UI can show exactly what will move.
    evaluation.quote = await quoteFor(evaluation.intent).catch((e) => ({ error: e.message }));
  }
  evaluation.snapshot = snapshot;
  return evaluation;
}

async function evaluateInterest(rule) {
  const [position, asset] = await Promise.all([
    readPosition({ owner: rule.wallet, vaultAddress: rule.kaminoVault, shareMint: rule.kaminoShareMint }),
    getAsset(rule.destinationSymbol),
  ]);

  if (!position.available) {
    return {
      status: STATUS.BLOCKED,
      reason: position.reason === 'KAMINO_SDK_UNAVAILABLE'
        ? 'Kamino SDK is not installed on the server, so the lending position cannot be read.'
        : `Kamino position read failed: ${position.detail}`,
      guards: { positionRead: false, threshold: false, sourcePreserved: false, idempotent: true },
      position,
    };
  }

  const evaluation = evaluateInterestRule({
    rule,
    position,
    asset,
    allowOvernight: rule.allowOvernight,
    alreadyExecuted: false,
  });

  if (evaluation.status === STATUS.READY) {
    if (evaluation.executionKey && hasConfirmedExecution(evaluation.executionKey)) {
      return { ...evaluation, status: STATUS.BLOCKED, reason: 'This harvest observation was already executed.' };
    }
    evaluation.quote = await quoteFor(evaluation.intent).catch((e) => ({ error: e.message }));
  }
  evaluation.position = position;
  return evaluation;
}

async function quoteFor(intent) {
  if (!intent) return null;
  const order = await getOrder({
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    amountRawAtomic: intent.inputRawAtomic,
    slippageBps: intent.maxSlippageBps,
  });
  return order;
}
