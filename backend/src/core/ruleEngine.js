/**
 * Rule engine.
 *
 * Contains no SDK calls and no signing. It takes normalized adapter output and
 * decides eligibility, producing an immutable execution intent that the
 * execution layer may act on. Keeping protocol specifics out of here is what
 * lets a new earnings source be added without touching the invariant.
 */

import { extractDividend, assertSourcePreserved, dividendPlausibilityCheck } from './dividend.js';
import { classifyCorporateAction, activationWindowState } from '../adapters/xstocks/corporateActions.js';
import { harvestableAtomic, defaultSafetyBufferAtomic } from './principal.js';
import { thresholdGuard, tradingWindowGuard, quoteGuard } from './guards.js';
import { dividendExecutionKey, interestExecutionKey } from './idempotency.js';

export const STATUS = {
  WAITING: 'WAITING',
  READY: 'READY',
  BLOCKED: 'BLOCKED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
};

/**
 * Evaluate an xStock dividend rule.
 * `snapshot` is the pre-event record; `live` is freshly read chain/API state.
 */
export function evaluateDividendRule({ rule, snapshot, live, asset, priceUsdScaled, allowOvernight = false, alreadyExecuted = false }) {
  const guards = { eventType: false, activationSafe: false, sourcePreserved: false, threshold: false, idempotent: !alreadyExecuted, balanceUnchanged: false };

  if (!snapshot) {
    return result(STATUS.WAITING, 'No pending corporate action for this source.', guards);
  }

  const classification = classifyCorporateAction({ reason: snapshot.reason });
  guards.eventType = classification.supported;
  if (!classification.supported) {
    return result(STATUS.BLOCKED, `${classification.reason}: ${classification.detail ?? 'unsupported event type'}`, guards, { classification });
  }

  const window = activationWindowState(snapshot.activationDateTime);
  guards.activationSafe = window.safe;
  if (!window.safe) {
    const msg = window.state === 'PENDING'
      ? `Dividend activates in ${Math.ceil((window.msUntilActivation ?? 0) / 60000)} min.`
      : 'Inside the multiplier activation safety window.';
    return result(STATUS.WAITING, msg, guards, { window });
  }

  if (alreadyExecuted) {
    return result(STATUS.BLOCKED, 'This corporate action has already been executed for this wallet.', guards);
  }

  // The raw balance must not have moved between snapshot and activation, or we
  // no longer know what the user held when entitlement was struck.
  const balanceUnchanged = String(live.rawBalanceAtomic) === String(snapshot.rawBalanceAtomic);
  guards.balanceUnchanged = balanceUnchanged;
  if (!balanceUnchanged) {
    return result(
      STATUS.NEEDS_REVIEW,
      `Raw balance changed after the snapshot (${snapshot.rawBalanceAtomic} -> ${live.rawBalanceAtomic}). Entitlement cannot be inferred safely.`,
      guards,
    );
  }

  // The multiplier we act on must be the one the snapshot predicted.
  if (String(live.currentMultiplier) !== String(snapshot.multiplierAfter)) {
    return result(
      STATUS.NEEDS_REVIEW,
      `Live multiplier ${live.currentMultiplier} does not match the activated value ${snapshot.multiplierAfter} recorded for this event.`,
      guards,
    );
  }

  let math;
  try {
    math = extractDividend({
      rawBalanceAtomic: snapshot.rawBalanceAtomic,
      multiplierBefore: snapshot.multiplierBefore,
      multiplierAfter: snapshot.multiplierAfter,
      tokenDecimals: rule.sourceDecimals ?? 8,
    });
  } catch (err) {
    return result(STATUS.BLOCKED, `Dividend maths refused the event: ${err.message}`, guards);
  }

  const preserved = assertSourcePreserved(math);
  guards.sourcePreserved = preserved.ok;
  if (!preserved.ok) {
    return result(STATUS.BLOCKED, `${preserved.reason}: ${preserved.detail}`, guards, { math });
  }

  const plausible = dividendPlausibilityCheck(math);
  if (!plausible.ok) {
    return result(STATUS.BLOCKED, `${plausible.reason}: ${plausible.detail}`, guards, { math });
  }

  const window2 = tradingWindowGuard({ asset, allowOvernight });
  if (!window2.ok) {
    return result(STATUS.WAITING, describeTradingGuard(window2), guards, { math });
  }

  // Value the extraction so it can be compared against the rule threshold.
  const dividendValueUsdAtomic = priceUsdScaled
    ? valueRawAtUsd(math.dividendRawAtomic, rule.sourceDecimals ?? 8, priceUsdScaled)
    : null;
  if (dividendValueUsdAtomic !== null) {
    const t = thresholdGuard({ valueUsdAtomic: dividendValueUsdAtomic, minExecutionUsdAtomic: rule.minExecutionUsdAtomic });
    guards.threshold = t.ok;
    if (!t.ok) {
      return result(STATUS.WAITING, `Dividend value is below the $${fmtUsd(rule.minExecutionUsdAtomic)} threshold; it stays pending.`, guards, { math, dividendValueUsdAtomic });
    }
  } else {
    guards.threshold = true;
  }

  return result(STATUS.READY, 'Dividend isolated and source preservation proven.', guards, {
    math,
    dividendValueUsdAtomic,
    executionKey: dividendExecutionKey({
      wallet: rule.wallet,
      corporateActionId: snapshot.corporateActionId,
      symbol: rule.sourceId,
      activationDateTime: snapshot.activationDateTime,
    }),
    intent: {
      kind: 'DIVIDEND',
      inputMint: rule.sourceMint,
      inputRawAtomic: math.dividendRawAtomic,
      outputMint: rule.destinationMint,
      maxSlippageBps: rule.maxSlippageBps,
    },
  });
}

/** Evaluate a Kamino USDC interest rule. */
export function evaluateInterestRule({ rule, position, asset, allowOvernight = false, alreadyExecuted = false }) {
  const guards = { threshold: false, sourcePreserved: false, idempotent: !alreadyExecuted, positionRead: false };

  if (!position || position.redeemableAtomic === undefined || position.redeemableAtomic === null) {
    return result(STATUS.BLOCKED, 'Kamino position could not be read.', guards);
  }
  guards.positionRead = true;

  if (rule.principalFloorAtomic === undefined || rule.principalFloorAtomic === null) {
    return result(STATUS.BLOCKED, 'Principal floor is not set. Confirm it before activating the rule.', guards);
  }

  const buffer = rule.safetyBufferAtomic ?? defaultSafetyBufferAtomic(rule.principalFloorAtomic).toString();
  const harvestable = harvestableAtomic({
    redeemableAtomic: position.redeemableAtomic,
    principalFloorAtomic: rule.principalFloorAtomic,
    safetyBufferAtomic: buffer,
  });

  // Source preservation for the interest rule: the floor is untouched by a harvest.
  guards.sourcePreserved = BigInt(position.redeemableAtomic) - harvestable >= BigInt(rule.principalFloorAtomic);

  if (BigInt(position.redeemableAtomic) < BigInt(rule.principalFloorAtomic)) {
    return result(
      STATUS.BLOCKED,
      `Lending position is impaired: redeemable ${fmtUsd(position.redeemableAtomic)} is below the principal floor ${fmtUsd(rule.principalFloorAtomic)}. Principal is not guaranteed.`,
      guards,
      { harvestableAtomic: '0', impaired: true, shortfallAtomic: (BigInt(rule.principalFloorAtomic) - BigInt(position.redeemableAtomic)).toString() },
    );
  }

  if (alreadyExecuted) return result(STATUS.BLOCKED, 'This harvest observation was already executed.', guards);

  const t = thresholdGuard({ valueUsdAtomic: harvestable, minExecutionUsdAtomic: rule.minExecutionUsdAtomic });
  guards.threshold = t.ok;
  if (!t.ok) {
    return result(
      STATUS.WAITING,
      `Earnings of $${fmtUsd(harvestable)} are below the $${fmtUsd(rule.minExecutionUsdAtomic)} threshold. Nothing is consumed; the rule stays pending.`,
      guards,
      { harvestableAtomic: harvestable.toString(), safetyBufferAtomic: buffer },
    );
  }

  const w = tradingWindowGuard({ asset, allowOvernight });
  if (!w.ok) {
    return result(STATUS.WAITING, describeTradingGuard(w), guards, { harvestableAtomic: harvestable.toString() });
  }

  return result(STATUS.READY, 'Earnings exceed the threshold and sit entirely above the principal floor.', guards, {
    harvestableAtomic: harvestable.toString(),
    safetyBufferAtomic: buffer,
    executionKey: interestExecutionKey({
      wallet: rule.wallet,
      ruleId: rule.id,
      observedSlot: position.slot ?? 'na',
      harvestableAtomic: harvestable.toString(),
    }),
    intent: {
      kind: 'INTEREST',
      inputMint: rule.sourceMint,
      inputRawAtomic: harvestable.toString(),
      outputMint: rule.destinationMint,
      maxSlippageBps: rule.maxSlippageBps,
    },
  });
}

/** Final gate applied to a live quote just before signature. */
export function applyQuoteGuards({ evaluation, quote, rule }) {
  if (evaluation.status !== STATUS.READY) {
    return { ok: false, reason: 'NOT_READY', detail: evaluation.reason };
  }
  const g = quoteGuard({ quote, maxSlippageBps: rule.maxSlippageBps, maxPriceImpactBps: rule.maxPriceImpactBps ?? 100 });
  if (!g.ok) return g;
  if (String(quote.inAmount) !== String(evaluation.intent.inputRawAtomic)) {
    return { ok: false, reason: 'QUOTE_AMOUNT_MISMATCH', detail: `quote is for ${quote.inAmount}, intent is ${evaluation.intent.inputRawAtomic}` };
  }
  return g;
}

function describeTradingGuard(w) {
  if (w.reason === 'THIN_LIQUIDITY_WINDOW') return `Holding for a deeper market: ${w.detail}`;
  if (w.reason === 'MARKET_CLOSED') return 'Market is closed for this asset.';
  if (w.reason === 'TRADING_HALTED') return 'Trading is halted for this asset.';
  return w.reason;
}

function valueRawAtUsd(rawAtomic, tokenDecimals, priceUsdScaled) {
  // raw -> USDC atomic (6dp) at a price scaled by 1e18
  return ((BigInt(rawAtomic) * BigInt(priceUsdScaled)) / 10n ** BigInt(18 + tokenDecimals - 6)).toString();
}

function fmtUsd(atomic) {
  const v = BigInt(atomic);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0').slice(0, 2)}`;
}

function result(status, reason, guards, extra = {}) {
  return { status, reason, guards, ...extra };
}
