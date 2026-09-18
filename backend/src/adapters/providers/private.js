/**
 * Private-market token providers: PreStocks and Tessera.
 *
 * Field names are pinned to what each API ACTUALLY returns (verified live,
 * September 2026) -- not guessed. V4.1's normaliser guessed, looked for `mint`
 * or `mintAddress`, and dropped every PreStocks asset because PreStocks calls it
 * `contract_address`. Its test passed because the fixture used the same guess.
 *
 *   PreStocks  [{ name, symbol, contract_address, markPrice, tokenPrice, ... }]
 *   Tessera    [{ id, name, symbol, code, sector, mint, markPrice, ... }]  -- NO token price
 *
 * Every price here is a decimal STRING. Nothing is coerced through Number.
 */
const PRESTOCKS_URL = process.env.PRESTOCKS_API_URL || 'https://prestocks.com/api/prestocks';
const TESSERA_URL = process.env.TESSERA_API_URL || 'https://rest-api.tessera.pe/v1/public/token-details';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

async function getJsonText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
    return { json: JSON.parse(text), text };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a numeric field's literal digits from the raw body, so prices keep full precision. */
function literal(text, anchorValue, field) {
  const idx = text.indexOf(anchorValue);
  if (idx === -1) return null;
  const chunk = text.slice(idx, text.indexOf('}', idx) + 1);
  const m = new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`).exec(chunk);
  return m ? m[1] : null;
}

function positiveDecimal(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!/^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(str)) return null;
  return Number(str) > 0 ? str : null;
}

export function normalizePreStocks(row, rawText = '') {
  const mint = String(row.contract_address ?? '').trim();
  const symbol = String(row.symbol ?? '').trim().toUpperCase();
  if (!mint || !symbol) return null;
  return {
    provider: 'PRESTOCKS',
    category: 'PRIVATE_MARKET',
    symbol,
    name: String(row.name ?? symbol).replace(/\s*PreStocks\s*$/i, '') || symbol,
    mint,
    logo: row.image ?? null,
    markPriceUsd: positiveDecimal(literal(rawText, mint, 'markPrice') ?? row.markPrice),
    providerTokenPriceUsd: positiveDecimal(literal(rawText, mint, 'tokenPrice') ?? row.tokenPrice),
    markValuationUsd: row.markValuation ?? null,
    sourceUrl: row.external_url ?? null,
  };
}

export function normalizeTessera(row, rawText = '') {
  const mint = String(row.mint ?? '').trim();
  const symbol = String(row.symbol ?? '').trim().toUpperCase();
  if (!mint || !symbol) return null;
  return {
    provider: 'TESSERA',
    category: 'PRIVATE_MARKET',
    symbol,
    name: String(row.name ?? symbol).replace(/^T-/, ''),
    mint,
    logo: null,
    markPriceUsd: positiveDecimal(literal(rawText, mint, 'markPrice') ?? row.markPrice),
    // Tessera publishes no token price. The firewall derives one from the actual
    // Jupiter quote instead of failing closed on every Tessera route.
    providerTokenPriceUsd: null,
    markValuationUsd: row.markValuation ?? null,
    sector: row.sector ?? null,
  };
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function fetchPreStocks() {
  return cached('prestocks', async () => {
    const { json, text } = await getJsonText(PRESTOCKS_URL);
    const rows = Array.isArray(json) ? json : (json?.data ?? json?.items ?? []);
    return rows.map((r) => normalizePreStocks(r, text)).filter(Boolean);
  });
}

export async function fetchTessera() {
  return cached('tessera', async () => {
    const { json, text } = await getJsonText(TESSERA_URL);
    const rows = Array.isArray(json) ? json : (json?.data ?? json?.items ?? []);
    return rows.map((r) => normalizeTessera(r, text)).filter(Boolean);
  });
}
