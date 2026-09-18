/**
 * xStocks corporate-actions feed: GET /public/corporate-actions/history
 *
 * A better dividend source than multiplier history alone. Each event carries:
 *   eventId                       a STABLE id (the multiplier endpoint exposes none
 *                                 for a pending event, so we had to key on time)
 *   multiplierOld / multiplierNew EXACT decimal strings
 *   grossCashflowUsd / netCashflowUsd / withholdingTaxRate
 *
 * Verified live (September 2026): pagination is 1-BASED (`page=0` returns an
 * empty result, a trap), `?symbol=` filters, and dividends are caType
 * "CashDividend".
 *
 * PRECISION: multiplier history returns multipliers as JSON numbers, i.e. float64.
 * `1.007473488816939167` arrives there as `1.0074734888169392`. Binding an event to
 * its transition with exact decimal equality therefore FAILS for any multiplier
 * with more precision than a double -- 2 of MCDx's 5 real dividends. V4.1 compares
 * that way and silently never routes them. We bind at float64 precision (all the
 * history side carries) and then compute with the exact string.
 */
const BASE = () => process.env.XSTOCKS_API_BASE || 'https://api.xstocks.fi/api/v2';
const PATH = () => process.env.XSTOCKS_CORPORATE_ACTIONS_PATH || '/public/corporate-actions/history';

export const DIVIDEND_CA_TYPE = 'CashDividend';

export async function fetchCorporateActions(symbol, { maxPages = 20 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({ page: String(page) });
    if (symbol) qs.set('symbol', symbol);
    const res = await fetch(`${BASE()}${PATH()}?${qs}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`xStocks corporate actions ${res.status}`);
    const body = await res.json();
    const nodes = body?.nodes ?? [];
    out.push(...nodes.map(normalize));
    if (!body?.page?.hasNextPage || !nodes.length) break;
  }
  // The symbol filter is trusted, but checked: never act on another asset's event.
  return symbol ? out.filter((e) => e.symbol === symbol) : out;
}

function normalize(n) {
  return {
    eventId: n.eventId,
    version: n.version ?? null,
    symbol: n.xstockSymbol,
    underlyingSymbol: n.spvSymbol ?? null,
    caType: n.caType,
    effectiveTimeUtc: n.effectiveTimeUtc,
    multiplierOld: n.multiplierOld != null ? String(n.multiplierOld) : null,
    multiplierNew: n.multiplierNew != null ? String(n.multiplierNew) : null,
    grossCashflowUsd: n.grossCashflowUsd ?? null,
    netCashflowUsd: n.netCashflowUsd ?? null,
    withholdingTaxRate: n.withholdingTaxRate ?? null,
    status: n.status ?? null,
  };
}

/** Equal at float64 precision -- the most a JSON-number source can carry. */
export function float64Equal(a, b) {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/**
 * Bind a corporate action to its multiplier transition. EXACT on everything the
 * history side represents faithfully -- activation instant and reason -- and at
 * float64 precision on the multipliers, which is all history carries.
 *
 * Never falls back to "nearest timestamp" or "latest two entries". No bind, no
 * routing.
 */
export function bindToHistory(event, history) {
  if (event.caType !== DIVIDEND_CA_TYPE) return null;
  // Explicit, not incidental: a cancelled event must never route, whatever
  // fields it happens to carry.
  if (String(event.status ?? '').toLowerCase() === 'cancelled') return null;
  const target = Date.parse(event.effectiveTimeUtc);
  if (!Number.isFinite(target)) return null;
  const match = history.find((h) =>
    Date.parse(h.activationDateTime) === target
    && String(h.reason).toLowerCase() === 'dividend'
    && float64Equal(h.multiplierBefore, event.multiplierOld)
    && float64Equal(h.multiplierAfter, event.multiplierNew));
  if (!match) return null;
  return {
    corporateActionId: event.eventId,
    activationDateTime: event.effectiveTimeUtc,
    // The EXACT strings from the corporate-actions feed drive the maths.
    multiplierBefore: event.multiplierOld,
    multiplierAfter: event.multiplierNew,
    historyId: match.corporateActionId,
    grossCashflowUsd: event.grossCashflowUsd,
    netCashflowUsd: event.netCashflowUsd,
    withholdingTaxRate: event.withholdingTaxRate,
    reason: 'Dividend',
    source: 'CORPORATE_ACTIONS',
  };
}
