import test from 'node:test';
import assert from 'node:assert/strict';
import { impliedTokenPriceScaled, decideBand, premiumBpsDisplay, evaluateFirewall } from '../src/core/marketGuard.js';
import { normalizePreStocks, normalizeTessera } from '../src/adapters/providers/private.js';
import { parseDecimalToScaled, SCALE } from '../src/core/units.js';

const usd = (scaled) => Number(scaled / (SCALE / 100n)) / 100;

// Real quote observed live: 10 USDC -> PreStocks OpenAI, 9-decimal Token-2022
// mint carrying a scaled UI multiplier of 1.4861347.
const OPENAI_QUOTE = { inAmount: '10000000', outAmount: '6175561' };
const OPENAI_MULTIPLIER = '1.4861347';
const OPENAI_MARK = '968.6656831712495';

test('the implied price applies the Token-2022 multiplier (the V4.1 trap)', () => {
  const naive = impliedTokenPriceScaled({ inAmountAtomic: OPENAI_QUOTE.inAmount, outAmountRaw: OPENAI_QUOTE.outAmount, outDecimals: 9, multiplier: '1' });
  const scaled = impliedTokenPriceScaled({ inAmountAtomic: OPENAI_QUOTE.inAmount, outAmountRaw: OPENAI_QUOTE.outAmount, outDecimals: 9, multiplier: OPENAI_MULTIPLIER });
  // Naive reads raw units as UI units: $1619 per token, which does not exist.
  assert.ok(Math.abs(usd(naive) - 1619.29) < 0.05, `naive was ${usd(naive)}`);
  // Correct: ~$1089.60, in line with PreStocks' own reported ~$1066.
  assert.ok(Math.abs(usd(scaled) - 1089.60) < 0.05, `scaled was ${usd(scaled)}`);

  const mark = parseDecimalToScaled(OPENAI_MARK);
  assert.ok(premiumBpsDisplay(naive, mark) > 6000, 'the naive premium is wildly overstated');
  const real = premiumBpsDisplay(scaled, mark);
  assert.ok(real > 1200 && real < 1300, `real premium ~1248 bps, got ${real}`);
});

test('a mint with no multiplier prices identically either way', () => {
  const a = impliedTokenPriceScaled({ inAmountAtomic: '10000000', outAmountRaw: '10210198', outDecimals: 9, multiplier: '1' });
  assert.ok(Math.abs(usd(a) - 979.41) < 0.05, `T-OpenAI implied ${usd(a)}`);
});

test('the band is two-sided: a deep DISCOUNT is blocked when a floor is set', () => {
  const mark = parseDecimalToScaled('154.96537306932981');   // SpaceX mark
  const token = parseDecimalToScaled('121.87074856198629');  // trading 21% under it
  // V4.1 behaviour (no floor): passes.
  assert.equal(decideBand({ tokenScaled: token, referenceScaled: mark, maxPremiumBps: 100 }).pass, true);
  // With a floor: blocked as a likely stale mark or broken market.
  const d = decideBand({ tokenScaled: token, referenceScaled: mark, maxPremiumBps: 100, minPremiumBps: -500 });
  assert.equal(d.pass, false);
  assert.equal(d.breach, 'BELOW_MIN');
});

test('the decision is exact at the boundary, with no rounding in its favour', () => {
  const ref = parseDecimalToScaled('100');
  // Exactly +100 bps passes a 100 bps cap...
  assert.equal(decideBand({ tokenScaled: parseDecimalToScaled('101'), referenceScaled: ref, maxPremiumBps: 100 }).pass, true);
  // ...one hundred-millionth of a dollar more does not. A rounded premium
  // ("100 bps") would have let this through.
  assert.equal(decideBand({ tokenScaled: parseDecimalToScaled('101.00000001'), referenceScaled: ref, maxPremiumBps: 100 }).pass, false);
});

test('the firewall PASSES near-parity and BLOCKS an overpay, on live-shaped data', async () => {
  const rule = { marketGuardMode: 'TOKEN_PREMIUM', maxPremiumBps: 100, minPremiumBps: -500 };
  const anthropic = { symbol: 'ANTHROPIC', provider: 'PRESTOCKS', markPriceUsd: '1015.50721235', providerTokenPriceUsd: '1016.116102811295' };
  const openai = { symbol: 'OPENAI', provider: 'PRESTOCKS', markPriceUsd: OPENAI_MARK, providerTokenPriceUsd: '1066.7610573208356' };

  assert.equal((await evaluateFirewall(rule, anthropic)).decision, 'PASS');
  const o = await evaluateFirewall(rule, openai);
  assert.equal(o.decision, 'BLOCK');
  assert.equal(o.breach, 'ABOVE_MAX');
  assert.match(o.reason, /overpay/);
});

test('the executable quote outranks the provider price', async () => {
  const rule = { marketGuardMode: 'TOKEN_PREMIUM', maxPremiumBps: 100 };
  // Provider claims near-parity, but the price the user would actually pay is 12% over.
  const openai = { symbol: 'OPENAI', provider: 'PRESTOCKS', markPriceUsd: OPENAI_MARK, providerTokenPriceUsd: '970' };
  const e = await evaluateFirewall(rule, openai, { quote: OPENAI_QUOTE, outDecimals: 9, multiplier: OPENAI_MULTIPLIER });
  assert.equal(e.decision, 'BLOCK');
  assert.match(e.tokenSource, /Jupiter executable quote/);
});

test('it fails closed with no token price, instead of every Tessera route silently dying', async () => {
  const rule = { marketGuardMode: 'TOKEN_PREMIUM', maxPremiumBps: 100 };
  const t = { symbol: 'T-OPENAI', provider: 'TESSERA', markPriceUsd: '812.79', providerTokenPriceUsd: null };
  const noQuote = await evaluateFirewall(rule, t);
  assert.equal(noQuote.decision, 'BLOCK');
  assert.equal(noQuote.breach, 'NO_EVIDENCE');
  // With a real quote, Tessera is evaluable -- V4.1 blocked it unconditionally.
  const withQuote = await evaluateFirewall(rule, t, { quote: { inAmount: '10000000', outAmount: '10210198' }, outDecimals: 9 });
  assert.notEqual(withQuote.breach, 'NO_EVIDENCE');
  assert.equal(withQuote.decision, 'BLOCK', 'T-OpenAI is ~2050 bps over its mark');
});

test('a firewall that is on but unconfigured blocks rather than waves through', async () => {
  const e = await evaluateFirewall({ marketGuardMode: 'TOKEN_PREMIUM', maxPremiumBps: null }, { symbol: 'X', provider: 'PRESTOCKS', markPriceUsd: '1' });
  assert.equal(e.decision, 'BLOCK');
  assert.equal((await evaluateFirewall({ marketGuardMode: 'NONE' }, {})).decision, 'NOT_REQUIRED');
});

test('PYTH_PARITY fails closed when Pyth is unavailable', async () => {
  const e = await evaluateFirewall(
    { marketGuardMode: 'PYTH_PARITY', maxPremiumBps: 100 },
    { symbol: 'NVDAx', provider: 'XSTOCKS', providerTokenPriceUsd: '180' },
    { pythPrice: async () => { throw new Error('Pyth Pro is not configured'); } },
  );
  assert.equal(e.decision, 'BLOCK');
  assert.match(e.reason, /Pyth Pro is not configured/);
});

test('providers normalise from their REAL field shapes', () => {
  const p = normalizePreStocks({ name: 'OpenAI PreStocks', symbol: 'OPENAI', contract_address: 'PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF', markPrice: 968.66, tokenPrice: 1066.76 });
  assert.equal(p.mint, 'PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF');
  assert.equal(p.category, 'PRIVATE_MARKET');
  assert.equal(p.name, 'OpenAI');
  const t = normalizeTessera({ id: 'T-OpenAI', name: 'T-OpenAI', symbol: 'T-OpenAI', mint: 'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ', markPrice: 812.79 });
  assert.equal(t.mint, 'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ');
  assert.equal(t.providerTokenPriceUsd, null);
  // V4.1's guessed field names would have dropped this:
  assert.equal(normalizePreStocks({ symbol: 'X', mintAddress: 'abc' }), null);
});
