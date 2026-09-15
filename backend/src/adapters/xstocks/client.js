/**
 * xStocks public API client. No auth required for these endpoints.
 *
 * Schemas here were verified against the live API (September 2026); every shape
 * below is what the service actually returns, not what documentation implies.
 */
import { extractRawJsonNumber } from '../../core/units.js';

const DEFAULT_BASE = process.env.XSTOCKS_API_BASE || 'https://api.xstocks.fi/api/v2';
const NETWORK = 'Solana';

async function getJson(url, { timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`xStocks ${res.status} on ${url}: ${text.slice(0, 200)}`);
    return { json: JSON.parse(text), text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /public/assets?page=N
 * -> { nodes: [{ id, name, symbol, isin, underlyingSymbol, isTradingHalted,
 *                trading: { currency, tradingHoursMode, openNow, currentPeriod, ... },
 *                deployments: [{ address, network, ... }] }],
 *      page: { currentPage, hasNextPage } }
 */
export async function fetchAllAssets({ base = DEFAULT_BASE, maxPages = 30, concurrency = 6 } = {}) {
  // The catalogue is ~9 pages. Fetched one at a time it costs ~17s, which is the
  // whole cold-start budget; in parallel batches it is a couple of seconds.
  const first = await getJson(`${base}/public/assets?page=0`);
  const out = [...(first.json.nodes || [])];
  if (!first.json.page?.hasNextPage) return out;

  let page = 1;
  let reachedEnd = false;
  while (!reachedEnd && page < maxPages) {
    const batch = [];
    for (let i = 0; i < concurrency && page + i < maxPages; i++) batch.push(page + i);

    const results = await Promise.all(
      batch.map((p) => getJson(`${base}/public/assets?page=${p}`).catch(() => null)),
    );
    for (const result of results) {
      if (!result) continue;
      const nodes = result.json.nodes || [];
      out.push(...nodes);
      if (!result.json.page?.hasNextPage) reachedEnd = true;
    }
    page += concurrency;
  }
  return out;
}

export function toSolanaAsset(node) {
  const deployment = (node.deployments || []).find((d) => d.network === NETWORK);
  if (!deployment) return null;
  return {
    id: node.id,
    symbol: node.symbol,
    name: node.name,
    underlyingSymbol: node.underlyingSymbol,
    isin: node.isin,
    mint: deployment.address,
    logo: node.logo,
    isTradingHalted: Boolean(node.isTradingHalted),
    trading: {
      currency: node.trading?.currency ?? 'USD',
      tradingHoursMode: node.trading?.tradingHoursMode ?? null,
      openNow: node.trading?.openNow ?? null,
      currentPeriod: node.trading?.currentPeriod ?? null,
    },
  };
}

/**
 * GET /public/assets/{symbol}/multiplier?network=Solana
 * -> { currentMultiplier, newMultiplier, activationDateTime, reason }
 *
 * newMultiplier is 0 and activationDateTime is 0 when nothing is pending; a
 * pending corporate action populates both, and `reason` names its type.
 *
 * The multiplier is read out of the RAW body rather than the parsed object: it
 * carries ~17 significant digits and must not be laundered through a double.
 */
export async function fetchMultiplier(symbol, { base = DEFAULT_BASE } = {}) {
  const url = `${base}/public/assets/${encodeURIComponent(symbol)}/multiplier?network=${NETWORK}`;
  const { json, text } = await getJson(url);
  const currentLiteral = extractRawJsonNumber(text, 'currentMultiplier') ?? String(json.currentMultiplier);
  const newLiteral = extractRawJsonNumber(text, 'newMultiplier') ?? String(json.newMultiplier);
  const pending = Number(json.newMultiplier) > 0 && Boolean(json.activationDateTime);
  return {
    symbol,
    currentMultiplier: currentLiteral,
    newMultiplier: pending ? newLiteral : null,
    activationDateTime: pending ? json.activationDateTime : null,
    reason: json.reason ?? null,
    pending,
  };
}

/**
 * GET /public/assets/{symbol}/multiplier/history?network=Solana
 * -> { nodes: [{ id, reason, multiplier, previousMultiplier, activationDateTime }] }
 *
 * `reason` is one of: Dividend | Split | ReverseSplit | Administrative.
 * `multiplier` is the value AFTER the event, `previousMultiplier` the value before.
 */
export async function fetchMultiplierHistory(symbol, { base = DEFAULT_BASE } = {}) {
  const url = `${base}/public/assets/${encodeURIComponent(symbol)}/multiplier/history?network=${NETWORK}`;
  const { json, text } = await getJson(url);
  const nodes = json.nodes || [];
  // Recover exact literals per entry by slicing the raw body around each id.
  return nodes.map((n) => {
    const chunk = sliceAround(text, n.id);
    return {
      corporateActionId: n.id,
      reason: n.reason,
      multiplierAfter: extractRawJsonNumber(chunk, 'multiplier') ?? String(n.multiplier),
      multiplierBefore: extractRawJsonNumber(chunk, 'previousMultiplier') ?? String(n.previousMultiplier),
      activationDateTime: n.activationDateTime,
      symbol,
    };
  });
}

function sliceAround(text, id) {
  const i = text.indexOf(id);
  if (i === -1) return text;
  const end = text.indexOf('}', i);
  return text.slice(i, end === -1 ? undefined : end + 1);
}

/** GET /public/assets/{symbol}/price-data */
export async function fetchPriceData(symbol, { base = DEFAULT_BASE } = {}) {
  try {
    const { json } = await getJson(`${base}/public/assets/${encodeURIComponent(symbol)}/price-data`);
    return json;
  } catch {
    return null;
  }
}
