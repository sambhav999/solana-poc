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
import { fetchCorporateActions, bindToHistory } from '../adapters/xstocks/corporateActionsFeed.js';

/**
 * Attach the published corporate action to each history entry, where one binds
 * exactly. That brings the stable event id, the EXACT multiplier strings (history
 * carries float-rounded ones), and the gross/net cashflow and withholding tax.
 */
async function enrichedHistory(symbol) {
  const [history, actions] = await Promise.all([
    fetchMultiplierHistory(symbol),
    fetchCorporateActions(symbol).catch(() => []),
  ]);
  return history.map((h) => {
    const bound = actions.map((e) => bindToHistory(e, [h])).find(Boolean) ?? null;
    return bound
      ? { ...h, multiplierBefore: bound.multiplierBefore, multiplierAfter: bound.multiplierAfter,
          eventId: bound.corporateActionId, grossCashflowUsd: bound.grossCashflowUsd,
          netCashflowUsd: bound.netCashflowUsd, withholdingTaxRate: bound.withholdingTaxRate,
          source: 'CORPORATE_ACTIONS', precisionUpgraded: String(h.multiplierBefore) !== bound.multiplierBefore
            || String(h.multiplierAfter) !== bound.multiplierAfter }
      : { ...h, source: 'MULTIPLIER_HISTORY' };
  });
}

export async function listReplayEvents(symbol) {
  const history = await enrichedHistory(symbol);
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
  const history = await enrichedHistory(symbol);
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
