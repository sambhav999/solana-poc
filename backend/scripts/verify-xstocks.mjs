#!/usr/bin/env node
/**
 * Verify the xStocks adapter against the live API for one symbol.
 * Usage: npm run verify:xstocks -- MCDx
 */
import 'dotenv/config';
import { fetchMultiplier, fetchMultiplierHistory } from '../src/adapters/xstocks/client.js';
import { classifyCorporateAction } from '../src/adapters/xstocks/corporateActions.js';
import { getAsset } from '../src/services/assets.js';
import { getMintInfo, crossCheckMultiplier } from '../src/adapters/solana/rpc.js';
import { extractDividend } from '../src/core/dividend.js';

const symbol = process.argv[2] || 'MCDx';
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log(`\nxStocks verification — ${symbol}\n`);

const asset = await getAsset(symbol);
check('asset resolves to a Solana mint', Boolean(asset?.mint), asset?.mint ?? 'not found');
if (!asset?.mint) process.exit(1);

const mint = await getMintInfo(asset.mint).catch((e) => ({ error: e.message }));
check('mint is Token-2022', mint.isToken2022 === true, mint.program ?? mint.error);
check('mint exposes a scaled UI multiplier', Boolean(mint.effectiveMultiplier), mint.effectiveMultiplier ?? '—');
check('decimals read from chain', Number.isInteger(mint.decimals), `decimals=${mint.decimals}`);

const api = await fetchMultiplier(symbol).catch((e) => ({ error: e.message }));
check('multiplier endpoint responds', !api.error, api.error ?? `current=${api.currentMultiplier}`);

const cross = await crossCheckMultiplier({ mint: asset.mint, apiMultiplier: api.currentMultiplier });
check('API multiplier matches chain', cross.checked && cross.matches,
  cross.checked ? `api=${cross.api} chain=${cross.onchain}` : cross.reason);

const history = await fetchMultiplierHistory(symbol).catch(() => []);
check('multiplier history available', history.length > 0, `${history.length} events`);

const dividends = history.filter((e) => classifyCorporateAction(e).supported);
const rejected = history.filter((e) => !classifyCorporateAction(e).supported);
check('at least one supported Dividend event', dividends.length > 0, `${dividends.length} dividends`);
if (rejected.length) {
  console.log(`  NOTE  ${rejected.length} event(s) correctly refused: ${[...new Set(rejected.map((e) => e.reason))].join(', ')}`);
}

if (dividends.length) {
  const e = dividends[0];
  const math = extractDividend({
    rawBalanceAtomic: 1_000_000_000n,
    multiplierBefore: e.multiplierBefore,
    multiplierAfter: e.multiplierAfter,
    tokenDecimals: mint.decimals ?? 8,
  });
  check('preservation invariant holds on the latest dividend', math.invariantHolds,
    `${math.display.preEventExposure} → ${math.display.remainingExposure} (routed ${math.display.dividendExposure})`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
