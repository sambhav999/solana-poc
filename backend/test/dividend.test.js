import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDividend, assertSourcePreserved, dividendPlausibilityCheck, DividendMathError } from '../src/core/dividend.js';
import { classifyCorporateAction, SUPPORTED_REASONS } from '../src/adapters/xstocks/corporateActions.js';

// Fixtures below are REAL events pulled from
// https://api.xstocks.fi/api/v2/public/assets/{SYMBOL}/multiplier/history?network=Solana
const MRKx_2026_06_14 = { before: '1.0165817315911818', after: '1.0216625054701978' };
const KLACx_SPLIT_10_1 = { before: '1.000892302917', after: '10.00892302917' };
const AZNx_REVERSE_SPLIT = { before: '1.003871122822', after: '0.501935561411' };

test('extraction holds the pre-event exposure exactly (real MRKx dividend)', () => {
  const R = 1_000_000_000n; // 10.00000000 MRKx at 8 decimals
  const r = extractDividend({
    rawBalanceAtomic: R,
    multiplierBefore: MRKx_2026_06_14.before,
    multiplierAfter: MRKx_2026_06_14.after,
    tokenDecimals: 8,
  });
  assert.equal(r.invariantHolds, true);
  assert.ok(BigInt(r.remainingExposure) >= BigInt(r.preEventExposure), 'source exposure must never shrink');
  assert.ok(BigInt(r.dividendRawAtomic) > 0n);
  assert.equal(BigInt(r.remainingRawAtomic) + BigInt(r.dividendRawAtomic), R, 'raw units must be conserved');
  // A real Merck quarterly dividend is a fraction of a percent of the position.
  assert.equal(dividendPlausibilityCheck(r).ok, true);
});

test('the preservation inequality is exact, not approximate, across many balances', () => {
  // Flooring the extraction can only ever leave the user with MORE than they
  // started with, never less. Assert that over a wide spread of raw balances.
  for (let i = 0; i < 400; i++) {
    const R = BigInt(1 + i * 7919) * 13n + BigInt(i);
    const r = extractDividend({
      rawBalanceAtomic: R,
      multiplierBefore: MRKx_2026_06_14.before,
      multiplierAfter: MRKx_2026_06_14.after,
      tokenDecimals: 8,
    });
    assert.ok(BigInt(r.remainingExposure) >= BigInt(r.preEventExposure), `invariant broke at R=${R}`);
    assert.ok(BigInt(r.preservationSurplus) >= 0n, `negative surplus at R=${R}`);
    assert.equal(BigInt(r.remainingRawAtomic) + BigInt(r.dividendRawAtomic), R);
  }
});

test('rounding always favours the user, never Overflow', () => {
  // 3 raw units and a tiny multiplier step: the dividend floors to zero rather
  // than taking a unit the user is entitled to keep.
  const r = extractDividend({
    rawBalanceAtomic: 3n,
    multiplierBefore: '1.0000000000000000',
    multiplierAfter: '1.0000000000000001',
    tokenDecimals: 8,
  });
  assert.equal(r.dividendRawAtomic, '0');
  assert.equal(r.remainingRawAtomic, '3');
  assert.equal(assertSourcePreserved(r).ok, false, 'a zero extraction must not proceed to a swap');
  assert.equal(assertSourcePreserved(r).reason, 'NO_DIVIDEND_EXPOSURE');
});

test('A 10:1 SPLIT would liquidate 90% of the position if treated as a dividend', () => {
  // This is the reason event classification is a safety control. The maths is
  // correct; applying it to the wrong event type is catastrophic.
  const R = 1_000_000_000n;
  const r = extractDividend({
    rawBalanceAtomic: R,
    multiplierBefore: KLACx_SPLIT_10_1.before,
    multiplierAfter: KLACx_SPLIT_10_1.after,
    tokenDecimals: 8,
  });
  const bps = (BigInt(r.dividendRawAtomic) * 10000n) / R;
  assert.ok(bps > 8900n, `expected ~9000 bps, got ${bps}`);

  // Two independent controls must both refuse it.
  assert.equal(classifyCorporateAction({ reason: 'Split' }).supported, false);
  const plaus = dividendPlausibilityCheck(r);
  assert.equal(plaus.ok, false);
  assert.equal(plaus.reason, 'IMPLAUSIBLE_DIVIDEND_SIZE');
});

test('a reverse split cannot enter the maths at all', () => {
  assert.throws(
    () => extractDividend({
      rawBalanceAtomic: 1_000_000_000n,
      multiplierBefore: AZNx_REVERSE_SPLIT.before,
      multiplierAfter: AZNx_REVERSE_SPLIT.after,
      tokenDecimals: 8,
    }),
    DividendMathError,
  );
  assert.equal(classifyCorporateAction({ reason: 'ReverseSplit' }).supported, false);
});

test('only Dividend is supported; everything else is refused by allowlist', () => {
  // Observed across all 832 Solana-deployed xStocks: Dividend, Split,
  // Administrative, ReverseSplit. Unknown future types must fail closed.
  assert.equal(classifyCorporateAction({ reason: 'Dividend' }).supported, true);
  for (const reason of ['Split', 'ReverseSplit', 'Administrative', 'Merger', null, undefined, '']) {
    assert.equal(classifyCorporateAction({ reason }).supported, false, `${reason} must not be supported`);
  }
  assert.deepEqual(SUPPORTED_REASONS, ['Dividend']);
});

test('extraction composes correctly across consecutive dividends', () => {
  // MRKx's four real events in order. Exposure must never dip below where each
  // stage started, and raw balance shrinks monotonically.
  const events = [
    { before: '1', after: '1.006441479605' },
    { before: '1.006441479605', after: '1.011376567180638' },
    { before: '1.011376567180638', after: '1.0165817315911818' },
    { before: '1.0165817315911818', after: '1.0216625054701978' },
  ];
  let R = 1_000_000_000n;
  for (const ev of events) {
    const r = extractDividend({ rawBalanceAtomic: R, multiplierBefore: ev.before, multiplierAfter: ev.after, tokenDecimals: 8 });
    assert.ok(BigInt(r.remainingExposure) >= BigInt(r.preEventExposure), 'invariant broke mid-chain');
    assert.ok(BigInt(r.remainingRawAtomic) < R, 'raw balance should fall as dividends are routed out');
    R = BigInt(r.remainingRawAtomic);
  }
  assert.ok(R > 970_000_000n, 'four quarterly dividends should cost well under 3% of raw units');
});

test('refuses to route the entire position', () => {
  const r = extractDividend({ rawBalanceAtomic: 1_000_000_000n, multiplierBefore: KLACx_SPLIT_10_1.before, multiplierAfter: KLACx_SPLIT_10_1.after, tokenDecimals: 8 });
  assert.equal(assertSourcePreserved(r).ok, true); // maths alone is self-consistent...
  assert.equal(dividendPlausibilityCheck(r).ok, false); // ...the size ceiling is what stops it
});
