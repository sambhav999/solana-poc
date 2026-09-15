import Decimal from 'decimal.js';

/** Current public xStocks v2 API base. */
const BASE = (process.env.XSTOCKS_API_BASE || 'https://api.xstocks.fi/api/v2').replace(/\/+$/, '');
const NETWORK = process.env.XSTOCKS_NETWORK || 'Solana';

async function getJson(path: string) {
  const r = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`xStocks ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

function unwrapList(data: any): any[] {
  // xStocks v2 list endpoints have used both `items` and paginated `nodes`
  // envelopes. Accept the documented/public shapes without silently turning a
  // successful response into an empty list.
  const candidates = [
    data?.data?.nodes, data?.data?.items, data?.data?.results,
    data?.nodes, data?.items, data?.results,
    data?.page?.nodes, data?.data, data,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

async function getJsonAny(paths: string[]) {
  let last: unknown = null;
  for (const path of paths) {
    try { return await getJson(path); } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(`xStocks request failed for ${paths.join(', ')}`);
}

export async function xstockAsset(symbol: string) {
  return getJson(`/public/assets/${encodeURIComponent(symbol)}`);
}

export async function solanaMintFor(symbol: string): Promise<string> {
  const data = await xstockAsset(symbol);
  const root = data?.data ?? data;
  const list = root?.tokenDeployments || root?.deployments || root?.networks || root?.asset?.tokenDeployments || [];
  const deployment = list.find((d: any) =>
    String(d.network || d.networkName || d.chain || d.blockchain || d?.network?.name || '').toLowerCase().includes('solana')
  );
  const mint = deployment?.tokenAddress || deployment?.address || deployment?.mint || deployment?.contractAddress;
  if (!mint) throw new Error(`No Solana deployment found for ${symbol}`);
  return String(mint);
}

export async function multiplierHistory(symbol: string): Promise<any[]> {
  const data = await getJson(
    `/public/assets/${encodeURIComponent(symbol)}/multiplier/history?network=${encodeURIComponent(NETWORK)}`
  );
  return unwrapList(data);
}

export interface CurrentMultiplierState {
  multiplier: string;
  activationAt?: string;
  pendingMultiplier?: string;
  pendingActivationAt?: string;
  raw: any;
}

export async function currentMultiplierState(symbol: string): Promise<CurrentMultiplierState> {
  const data = await getJson(
    `/public/assets/${encodeURIComponent(symbol)}/multiplier?network=${encodeURIComponent(NETWORK)}`
  );
  const root = data?.data ?? data;
  const current = root?.current ?? root;
  const pending = root?.pending ?? root?.next ?? {};
  const multiplier = String(
    current?.multiplier ?? root?.multiplier ?? root?.value ?? root?.currentMultiplier ?? '1'
  );
  const activationAt = current?.activationAt ?? current?.activationDate ?? root?.activationAt ?? root?.activationDate;
  const pendingMultiplier = pending?.multiplier ?? root?.pendingMultiplier;
  const pendingActivationAt = pending?.activationAt ?? pending?.activationDate ?? root?.pendingActivationAt;
  return {
    multiplier,
    activationAt: activationAt ? String(activationAt) : undefined,
    pendingMultiplier: pendingMultiplier == null ? undefined : String(pendingMultiplier),
    pendingActivationAt: pendingActivationAt ? String(pendingActivationAt) : undefined,
    raw: data,
  };
}

export async function currentMultiplier(symbol: string): Promise<string> {
  return (await currentMultiplierState(symbol)).multiplier;
}

export async function assetPriceUsd(symbol: string): Promise<Decimal> {
  const data = await getJson(`/public/assets/${encodeURIComponent(symbol)}/price-data`);
  const root = data?.data ?? data;
  const candidates = [
    root?.price,
    root?.lastPrice,
    root?.marketPrice,
    root?.close,
    root?.nasdaq?.price,
    root?.onchain?.price,
    root?.priceUsd,
  ];
  for (const v of candidates) {
    if (v == null) continue;
    const d = new Decimal(String(v));
    if (d.isFinite() && d.gt(0)) return d;
  }
  throw new Error(`No positive USD price found for ${symbol}`);
}

export async function corporateActions(): Promise<any[]> {
  // Keep the v2 history endpoint as primary, but tolerate the non-/history list
  // form used by some public API revisions. Preflight verifies whichever one is live.
  const data = await getJsonAny(['/public/corporate-actions/history', '/public/corporate-actions']);
  return unwrapList(data);
}

/** Cash dividends only. Splits and reverse splits must never be routed as earnings. */
export function normalizeCashDividends(actions: any[], symbol: string) {
  return actions
    .filter((a: any) => {
      const s = String(
        a.symbol || a.ticker || a.assetSymbol || a.identifier ||
        a?.asset?.symbol || a?.asset?.identifier || ''
      ).toUpperCase();
      const t = String(
        a.caType || a.type || a.actionType || a.eventType || a.corporateActionType ||
        a?.action?.type || ''
      );
      return s === symbol.toUpperCase() && ['CashDividend', 'DVCA'].includes(t);
    })
    .map((a: any) => ({
      eventId: String(
        a.id || a.eventId || a.corporateActionId || a?.corporateAction?.id ||
        `${symbol}-${a.effectiveDate || a.effectiveAt || a.exDate || a.exDateTime || a.date}`
      ),
      symbol,
      effectiveAt: String(a.effectiveDate || a.effectiveAt || a.exDate || a.exDateTime || a.date || ''),
      raw: a,
    }));
}

export async function latestCashDividend(symbol: string) {
  const list = normalizeCashDividends(await corporateActions(), symbol);
  return list.sort((a, b) => Date.parse(b.effectiveAt || '0') - Date.parse(a.effectiveAt || '0'))[0] || null;
}

export interface MultiplierPair {
  m0: string;
  m1: string;
  activationAt?: string;
  matchedBy: 'eventId' | 'corporateActionId';
  entry: any;
}

function historyTime(x: any) {
  return String(x.activationAt || x.activationDate || x.effectiveAt || x.date || x.timestamp || '');
}

/**
 * Resolve one exact corporate action to its multiplier history entry.
 * No nearest-date/latest-two fallback: a wrong pair can be internally consistent
 * and still extract the wrong amount, so an unmatched event is BLOCKED upstream.
 */
export async function resolveMultiplierPair(symbol: string, eventId: string): Promise<MultiplierPair | null> {
  const history = (await multiplierHistory(symbol)).slice().sort(
    (a: any, b: any) => Date.parse(historyTime(a) || '0') - Date.parse(historyTime(b) || '0')
  );

  const idx = history.findIndex((x: any) => {
    const ids = [x.eventId, x.corporateActionId, x.id, x?.corporateAction?.id].filter(Boolean).map(String);
    return ids.includes(eventId);
  });
  if (idx < 0) return null;

  const after = history[idx];
  // Some APIs expose both previous/current multiplier on the same event. Prefer it.
  let m0 = after?.previousMultiplier ?? after?.multiplierBefore ?? after?.oldMultiplier ?? after?.previousValue;
  const m1 = after?.multiplier ?? after?.value ?? after?.multiplierValue ?? after?.multiplierAfter ?? after?.newMultiplier;
  if (m0 == null && idx > 0) {
    const before = history[idx - 1];
    m0 = before?.multiplier ?? before?.value ?? before?.multiplierValue ?? before?.multiplierAfter ?? before?.newMultiplier;
  }
  if (m0 == null || m1 == null) return null;

  const exactEvent = String(after?.eventId ?? '') === eventId;
  return {
    m0: String(m0),
    m1: String(m1),
    activationAt: historyTime(after) || undefined,
    matchedBy: exactEvent ? 'eventId' : 'corporateActionId',
    entry: after,
  };
}

/** True once the public current-multiplier endpoint reports m1 or greater. */
export async function multiplierIsLive(symbol: string, expected: string): Promise<boolean> {
  const live = new Decimal(await currentMultiplier(symbol));
  return live.gte(new Decimal(expected));
}
