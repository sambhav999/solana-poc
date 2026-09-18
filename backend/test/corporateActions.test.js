import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { bindToHistory, float64Equal } from '../src/adapters/xstocks/corporateActionsFeed.js';

// REAL records, captured live. Multiplier history returns JSON numbers (float64);
// corporate actions returns exact strings.
const MCDX_HISTORY = [
  { corporateActionId: 'h1', reason: 'Dividend', activationDateTime: '2026-03-03T01:15:00.000Z',
    multiplierBefore: '1.0074734888169392', multiplierAfter: '1.0113912072404925' },
];
const MCDX_EVENT = {
  eventId: '8c733eb6', caType: 'CashDividend', status: 'Initial',
  effectiveTimeUtc: '2026-03-03T01:15:00.000Z',
  multiplierOld: '1.007473488816939167', multiplierNew: '1.0113912072404925',
  grossCashflowUsd: '1.86', netCashflowUsd: '1.302', withholdingTaxRate: '0.3',
};

test('binds across float64 precision loss -- the case V4.1 drops', () => {
  // V4.1 compares with exact decimal equality, which fails here:
  assert.equal(new Decimal(MCDX_HISTORY[0].multiplierBefore).eq(MCDX_EVENT.multiplierOld), false);
  // ...but the float64 of the exact string IS the history value:
  assert.equal(float64Equal(MCDX_HISTORY[0].multiplierBefore, MCDX_EVENT.multiplierOld), true);

  const b = bindToHistory(MCDX_EVENT, MCDX_HISTORY);
  assert.ok(b, 'a real MCDx dividend must bind');
  assert.equal(b.corporateActionId, '8c733eb6', 'the stable event id is carried forward');
  // The maths uses the EXACT string, not the float-rounded one.
  assert.equal(b.multiplierBefore, '1.007473488816939167');
  assert.equal(b.withholdingTaxRate, '0.3');
  assert.equal(b.netCashflowUsd, '1.302');
});

test('a cancelled event never routes', () => {
  const cancelled = { ...MCDX_EVENT, status: 'Cancelled' };
  assert.equal(bindToHistory(cancelled, MCDX_HISTORY), null);
});

test('a superseded revision whose multiplier never went live is refused (real NVDAx v2)', () => {
  // v2 proposed 1.0001029207653542 at 23:55; v4 replaced it at 11:20 the next day.
  // History has NO transition at 23:55, so v2 describes a multiplier that never existed.
  const history = [{
    corporateActionId: 'h', reason: 'Dividend', activationDateTime: '2026-04-02T11:20:00.000Z',
    multiplierBefore: '1.0000658218334353', multiplierAfter: '1.000103090792305',
  }];
  const v2 = { eventId: 'v2', caType: 'CashDividend', status: 'Initial', effectiveTimeUtc: '2026-04-01T23:55:00.000Z',
    multiplierOld: '1.000065821833435198', multiplierNew: '1.0001029207653542' };
  const v4 = { eventId: 'v4', caType: 'CashDividend', status: 'Initial', effectiveTimeUtc: '2026-04-02T11:20:00.000Z',
    multiplierOld: '1.000065821833435198', multiplierNew: '1.000103090792305' };
  assert.equal(bindToHistory(v2, history), null, 'the superseded version must not route');
  assert.equal(bindToHistory(v4, history)?.corporateActionId, 'v4', 'the version that went live binds');
});

test('no fallback to a nearby timestamp or a similar multiplier', () => {
  const offByAMinute = { ...MCDX_EVENT, effectiveTimeUtc: '2026-03-03T01:16:00.000Z' };
  assert.equal(bindToHistory(offByAMinute, MCDX_HISTORY), null);
  const differentMultiplier = { ...MCDX_EVENT, multiplierNew: '1.0113912072404926' };
  assert.equal(bindToHistory(differentMultiplier, MCDX_HISTORY), null);
});

test('a split never binds, even at the right time', () => {
  const split = { ...MCDX_EVENT, caType: 'StockSplit' };
  assert.equal(bindToHistory(split, MCDX_HISTORY), null);
  const history = [{ ...MCDX_HISTORY[0], reason: 'Split' }];
  assert.equal(bindToHistory(MCDX_EVENT, history), null);
});
