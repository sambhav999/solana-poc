/**
 * Replay Mode.
 *
 * Runs the real extraction maths over a REAL historical xStocks corporate action,
 * with a stated hypothetical balance. It exists because dividends are scheduled
 * events: at the time of writing, a scan of all 832 Solana-deployed xStocks found
 * zero pending actions, so a live dividend cannot be summoned on demand.
 *
 * What it must never do is imply a swap happened. It produces no signature, no
 * receipt marked CONFIRMED, and every response carries mode: 'REPLAY'.
 */
import { fetchMultiplierHistory } from '../adapters/xstocks/client.js';
import { classifyCorporateAction } from '../adapters/xstocks/corporateActions.js';
import { extractDividend, assertSourcePreserved, dividendPlausibilityCheck } from '../core/dividend.js';

export async function listReplayEvents(symbol) {
  const history = await fetchMultiplierHistory(symbol);
  return history.map((e) => {
    const c = classifyCorporateAction(e);
    return {
      ...e,
      supported: c.supported,
      eventType: c.eventType,
      unsupportedDetail: c.detail ?? null,
    };
  });
}

/**
 * Replay one event. `rawBalanceAtomic` is an explicitly hypothetical holding and
 * is labelled as such in the response.
 */
export async function replayEvent({ symbol, corporateActionId, rawBalanceAtomic, tokenDecimals = 8 }) {
  const history = await fetchMultiplierHistory(symbol);
  const event = history.find((e) => e.corporateActionId === corporateActionId);
  if (!event) return { ok: false, reason: 'EVENT_NOT_FOUND' };

  const classification = classifyCorporateAction(event);
  if (!classification.supported) {
    // Still useful to show: this is precisely what the safety control refuses.
    let wouldHaveExtracted = null;
    try {
      const hypothetical = extractDividend({
        rawBalanceAtomic, multiplierBefore: event.multiplierBefore, multiplierAfter: event.multiplierAfter, tokenDecimals,
      });
      const bps = (BigInt(hypothetical.dividendRawAtomic) * 10000n) / BigInt(rawBalanceAtomic);
      wouldHaveExtracted = { dividendRawAtomic: hypothetical.dividendRawAtomic, fractionBps: bps.toString() };
    } catch (err) {
      wouldHaveExtracted = { error: err.message };
    }
    return {
      ok: false,
      mode: 'REPLAY',
      reason: 'UNSUPPORTED_EVENT_TYPE',
      event,
      classification,
      wouldHaveExtracted,
      note: 'Overflow refuses this event. The figure above is what a naive implementation that only watched the multiplier would have routed.',
    };
  }

  const math = extractDividend({
    rawBalanceAtomic,
    multiplierBefore: event.multiplierBefore,
    multiplierAfter: event.multiplierAfter,
    tokenDecimals,
  });
  return {
    ok: true,
    mode: 'REPLAY',
    event,
    classification,
    hypotheticalBalance: { rawBalanceAtomic: String(rawBalanceAtomic), tokenDecimals, stated: 'HYPOTHETICAL' },
    math,
    preservation: assertSourcePreserved(math),
    plausibility: dividendPlausibilityCheck(math),
    disclaimer: 'Historical corporate action with a hypothetical balance. No transaction was executed and no position was held.',
  };
}
