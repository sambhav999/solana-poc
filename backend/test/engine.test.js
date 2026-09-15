import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDividendRule, evaluateInterestRule, applyQuoteGuards, STATUS } from '../src/core/ruleEngine.js';
import { quoteGuard, tradingWindowGuard, percentStringToBps } from '../src/core/guards.js';
import { dividendExecutionKey, interestExecutionKey } from '../src/core/idempotency.js';

const usdc = (n) => BigInt(Math.round(n * 1e6)).toString();

const openAsset = { symbol: 'SPYx', isTradingHalted: false, trading: { openNow: true, currentPeriod: 'market' } };
const overnightAsset = { symbol: 'SPYx', isTradingHalted: false, trading: { openNow: true, currentPeriod: 'overnight' } };

const dividendRule = {
  id: 'r1', wallet: 'W1', sourceId: 'MCDx', sourceMint: 'srcMint', sourceDecimals: 8,
  destinationMint: 'dstMint', minExecutionUsdAtomic: usdc(5), maxSlippageBps: 50,
};

const activeSnapshot = {
  corporateActionId: 'ca-1', reason: 'Dividend',
  rawBalanceAtomic: '1000000000',
  multiplierBefore: '1.0165817315911818', multiplierAfter: '1.0216625054701978',
  activationDateTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // an hour ago
};

test('a clean dividend evaluates READY and produces an execution intent', () => {
  const r = evaluateDividendRule({
    rule: dividendRule, snapshot: activeSnapshot,
    live: { rawBalanceAtomic: '1000000000', currentMultiplier: '1.0216625054701978' },
    asset: openAsset,
  });
  assert.equal(r.status, STATUS.READY);
  assert.equal(r.guards.eventType, true);
  assert.equal(r.guards.sourcePreserved, true);
  assert.equal(r.intent.inputMint, 'srcMint');
  assert.ok(BigInt(r.intent.inputRawAtomic) > 0n);
  assert.ok(r.executionKey);
});

test('a Split is BLOCKED before the maths can run', () => {
  const r = evaluateDividendRule({
    rule: dividendRule,
    snapshot: { ...activeSnapshot, reason: 'Split', multiplierBefore: '1.000892302917', multiplierAfter: '10.00892302917' },
    live: { rawBalanceAtomic: '1000000000', currentMultiplier: '10.00892302917' },
    asset: openAsset,
  });
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.guards.eventType, false);
  assert.match(r.reason, /Split/);
  assert.equal(r.intent, undefined, 'a blocked evaluation must not emit an execution intent');
});

test('a balance change after the snapshot forces NEEDS_REVIEW, never silent reuse', () => {
  const r = evaluateDividendRule({
    rule: dividendRule, snapshot: activeSnapshot,
    live: { rawBalanceAtomic: '900000000', currentMultiplier: '1.0216625054701978' },
    asset: openAsset,
  });
  assert.equal(r.status, STATUS.NEEDS_REVIEW);
  assert.equal(r.guards.balanceUnchanged, false);
});

test('a multiplier that disagrees with the snapshot forces NEEDS_REVIEW', () => {
  const r = evaluateDividendRule({
    rule: dividendRule, snapshot: activeSnapshot,
    live: { rawBalanceAtomic: '1000000000', currentMultiplier: '1.0299999999' },
    asset: openAsset,
  });
  assert.equal(r.status, STATUS.NEEDS_REVIEW);
});

test('the activation safety window holds execution', () => {
  const r = evaluateDividendRule({
    rule: dividendRule,
    snapshot: { ...activeSnapshot, activationDateTime: new Date(Date.now() - 60_000).toISOString() },
    live: { rawBalanceAtomic: '1000000000', currentMultiplier: '1.0216625054701978' },
    asset: openAsset,
  });
  assert.equal(r.status, STATUS.WAITING);
  assert.equal(r.guards.activationSafe, false);
});

test('an already-executed corporate action is BLOCKED', () => {
  const r = evaluateDividendRule({
    rule: dividendRule, snapshot: activeSnapshot,
    live: { rawBalanceAtomic: '1000000000', currentMultiplier: '1.0216625054701978' },
    asset: openAsset, alreadyExecuted: true,
  });
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.guards.idempotent, false);
});

test('the overnight window defers execution rather than trading a thin book', () => {
  const r = evaluateDividendRule({
    rule: dividendRule, snapshot: activeSnapshot,
    live: { rawBalanceAtomic: '1000000000', currentMultiplier: '1.0216625054701978' },
    asset: overnightAsset,
  });
  assert.equal(r.status, STATUS.WAITING);
  // ...unless the operator explicitly opts in.
  const forced = evaluateDividendRule({
    rule: dividendRule, snapshot: activeSnapshot,
    live: { rawBalanceAtomic: '1000000000', currentMultiplier: '1.0216625054701978' },
    asset: overnightAsset, allowOvernight: true,
  });
  assert.equal(forced.status, STATUS.READY);
});

test('interest rule: below threshold WAITS and consumes nothing', () => {
  const rule = { id: 'r2', wallet: 'W1', sourceMint: 'usdc', destinationMint: 'dst', minExecutionUsdAtomic: usdc(5), maxSlippageBps: 50, principalFloorAtomic: usdc(10000), safetyBufferAtomic: usdc(5) };
  const r = evaluateInterestRule({ rule, position: { redeemableAtomic: usdc(10007) }, asset: openAsset });
  assert.equal(r.status, STATUS.WAITING);
  assert.equal(r.guards.threshold, false);
  assert.equal(r.harvestableAtomic, usdc(2));
});

test('interest rule: harvest sits entirely above the floor', () => {
  const rule = { id: 'r2', wallet: 'W1', sourceMint: 'usdc', destinationMint: 'dst', minExecutionUsdAtomic: usdc(5), maxSlippageBps: 50, principalFloorAtomic: usdc(10000), safetyBufferAtomic: usdc(5) };
  const r = evaluateInterestRule({ rule, position: { redeemableAtomic: usdc(10030) }, asset: openAsset });
  assert.equal(r.status, STATUS.READY);
  assert.equal(r.harvestableAtomic, usdc(25));
  assert.equal(r.guards.sourcePreserved, true);
});

test('interest rule: an impaired position reports a shortfall, never a guarantee', () => {
  const rule = { id: 'r2', wallet: 'W1', sourceMint: 'usdc', destinationMint: 'dst', minExecutionUsdAtomic: usdc(5), maxSlippageBps: 50, principalFloorAtomic: usdc(10000), safetyBufferAtomic: usdc(5) };
  const r = evaluateInterestRule({ rule, position: { redeemableAtomic: usdc(9800) }, asset: openAsset });
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.impaired, true);
  assert.equal(r.shortfallAtomic, usdc(200));
  assert.match(r.reason, /not guaranteed/);
});

test('quote guards reject impact, missing routes, and amount mismatch', () => {
  assert.equal(quoteGuard({ quote: null }).ok, false);
  assert.equal(quoteGuard({ quote: { inAmount: '0', outAmount: '1' } }).reason, 'ZERO_INPUT');
  assert.equal(quoteGuard({ quote: { inAmount: '1', outAmount: '0' } }).reason, 'NO_OUTPUT');
  assert.equal(quoteGuard({ quote: { inAmount: '100', outAmount: '99', priceImpactPct: '0.003' } }).ok, true);
  assert.equal(quoteGuard({ quote: { inAmount: '100', outAmount: '50', priceImpactPct: '5' } }).reason, 'PRICE_IMPACT_TOO_HIGH');

  const evaluation = { status: STATUS.READY, intent: { inputRawAtomic: '1000' } };
  const mismatch = applyQuoteGuards({ evaluation, quote: { inAmount: '999', outAmount: '10', priceImpactPct: '0' }, rule: { maxSlippageBps: 50 } });
  assert.equal(mismatch.reason, 'QUOTE_AMOUNT_MISMATCH');
});

test('price impact converts to bps conservatively (rounds against the user)', () => {
  assert.equal(percentStringToBps('0.003229014187214996'), 1n); // 0.0032% -> 1bp, ceiled
  assert.equal(percentStringToBps('1'), 100n);
  assert.equal(percentStringToBps('0'), 0n);
  assert.equal(percentStringToBps('not-a-number'), null);
});

test('trading guards catch halts and closed markets', () => {
  assert.equal(tradingWindowGuard({ asset: { isTradingHalted: true, trading: {} } }).reason, 'TRADING_HALTED');
  assert.equal(tradingWindowGuard({ asset: { trading: { openNow: false, currentPeriod: 'closed' } } }).reason, 'MARKET_CLOSED');
  assert.equal(tradingWindowGuard({ asset: openAsset }).ok, true);
});

test('execution keys are stable and distinguish events', () => {
  const a = dividendExecutionKey({ wallet: 'W', corporateActionId: 'ca1', symbol: 'MCDx', activationDateTime: 't' });
  const b = dividendExecutionKey({ wallet: 'W', corporateActionId: 'ca1', symbol: 'MCDx', activationDateTime: 't' });
  const c = dividendExecutionKey({ wallet: 'W', corporateActionId: 'ca2', symbol: 'MCDx', activationDateTime: 't' });
  assert.equal(a, b, 'same event must yield the same key');
  assert.notEqual(a, c, 'different events must not collide');
  const i1 = interestExecutionKey({ wallet: 'W', ruleId: 'r', observedSlot: 1, harvestableAtomic: '100' });
  const i2 = interestExecutionKey({ wallet: 'W', ruleId: 'r', observedSlot: 2, harvestableAtomic: '100' });
  assert.notEqual(i1, i2, 'a new observation must be separately executable');
});
