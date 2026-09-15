/**
 * Asset registry: xStocks metadata joined to Jupiter routability.
 *
 * Routability is not cosmetic. Of 832 Solana-deployed xStocks, only a minority
 * have a live Jupiter route -- MRKx, for one, returns TOKEN_NOT_TRADABLE. A rule
 * whose source or destination cannot be routed can never execute, so the UI must
 * refuse to create it rather than fail at signature time.
 */
import { fetchAllAssets, toSolanaAsset, fetchMultiplier } from '../adapters/xstocks/client.js';
import { isTradable } from '../adapters/jupiter/client.js';
import { getMintInfo, USDC_MINT } from '../adapters/solana/rpc.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, bySymbol: new Map(), byMint: new Map() };

export const USDC_ASSET = {
  symbol: 'USDC',
  name: 'USD Coin',
  mint: USDC_MINT,
  decimals: 6,
  isStable: true,
  isTradingHalted: false,
  trading: { openNow: true, currentPeriod: 'market', tradingHoursMode: 'Always' },
};

export async function refreshAssets({ force = false } = {}) {
  if (!force && Date.now() - cache.at < CACHE_TTL_MS && cache.bySymbol.size) return cache;
  const nodes = await fetchAllAssets();
  const bySymbol = new Map();
  const byMint = new Map();
  for (const node of nodes) {
    const asset = toSolanaAsset(node);
    if (!asset) continue;
    asset.decimals = 8; // xStocks on Solana are 8dp; verified per-mint on demand
    bySymbol.set(asset.symbol, asset);
    byMint.set(asset.mint, asset);
  }
  bySymbol.set('USDC', USDC_ASSET);
  byMint.set(USDC_MINT, USDC_ASSET);
  cache = { at: Date.now(), bySymbol, byMint };
  return cache;
}

export async function getAsset(symbol) {
  const c = await refreshAssets();
  return c.bySymbol.get(symbol) ?? null;
}

export async function getAssetByMint(mint) {
  const c = await refreshAssets();
  return c.byMint.get(mint) ?? null;
}

/** Enrich an asset with on-chain truth: decimals, multiplier, and extension risks. */
export async function getAssetDetail(symbol) {
  const asset = await getAsset(symbol);
  if (!asset) return null;
  if (asset.isStable) return { ...asset, onchain: null, multiplier: null };

  const [mintInfo, multiplier] = await Promise.all([
    getMintInfo(asset.mint).catch((e) => ({ error: e.message })),
    fetchMultiplier(symbol).catch((e) => ({ error: e.message })),
  ]);
  return {
    ...asset,
    decimals: mintInfo?.decimals ?? asset.decimals,
    onchain: mintInfo,
    multiplier,
  };
}

/** The curated, verified-routable set the UI offers. Small and honest by design. */
const DEFAULT_DESTINATIONS = ['USDC', 'SPYx', 'QQQx', 'NVDAx'];

export async function listDestinations() {
  const out = [];
  for (const symbol of DEFAULT_DESTINATIONS) {
    const asset = await getAsset(symbol);
    if (!asset) continue;
    if (asset.isStable) { out.push({ ...asset, tradable: true, priceImpactPct: '0' }); continue; }
    const probe = await isTradable({ mint: asset.mint });
    out.push({
      ...asset,
      // An unverified destination stays selectable; blocking on a rate limit
      // would empty the dropdown whenever the API is busy.
      tradable: probe.tradable || Boolean(probe.unknown),
      unverified: Boolean(probe.unknown),
      priceImpactPct: probe.priceImpactPct ?? null,
      untradableReason: probe.unknown ? null : (probe.reason ?? null),
    });
  }
  return out;
}

/**
 * Check a candidate source can actually be sold before a rule is created.
 *
 * Three outcomes. A rate limit is NOT a routing verdict: it returns ok with a
 * warning so the user is not blocked from creating a rule on a perfectly
 * tradable asset because the API was busy.
 */
export async function checkSourceRoutable(symbol) {
  const asset = await getAsset(symbol);
  if (!asset) return { ok: false, reason: 'UNKNOWN_ASSET', detail: `No xStock named ${symbol}.` };
  if (asset.isStable) return { ok: true, asset };

  const probe = await isTradable({ mint: asset.mint });

  if (probe.unknown) {
    return {
      ok: true,
      unverified: true,
      asset,
      reason: probe.reason,
      detail: probe.reason === 'RATE_LIMITED'
        ? `Could not verify ${symbol}'s route: Jupiter rate-limited the request. This is not a verdict on the asset.`
        : probe.reason === 'NO_QUOTE_RIGHT_NOW'
        ? `No market maker quoted ${symbol} just now. That is a momentary condition, not a verdict — the route is re-quoted before anything is signed.`
        : `Could not verify ${symbol}'s route: ${probe.detail}`,
    };
  }

  if (!probe.tradable) {
    return {
      ok: false,
      reason: 'SOURCE_NOT_TRADABLE',
      detail: `${symbol} has no live Jupiter route (${probe.reason}). A dividend on it could be detected but never routed.`,
      asset,
    };
  }
  return { ok: true, asset, priceImpactPct: probe.priceImpactPct };
}
