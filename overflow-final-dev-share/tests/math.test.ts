import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  dividendRawAtomic, harvestableInterestUsd, sourceExposurePreserved,
  observedExposurePreserved, harvestPlausible, defaultSafetyBufferUsd, scaledExposure
} from '../lib/math';

describe('dividend isolation', () => {
  it('isolates only dividend-created raw exposure', () => {
    expect(dividendRawAtomic(1_000_000_000n, '1', '1.0064')).toBe(6_359_300n);
  });

  it('preserves pre-dividend exposure exactly, with no tolerance', () => {
    const raw = dividendRawAtomic(1_000_000_000n, '1', '1.0064');
    expect(sourceExposurePreserved({
      rawBefore: 1_000_000_000n, rawRemoved: raw, decimals: 8,
      multiplierBefore: '1', multiplierAfter: '1.0064'
    })).toBe(true);
    // one unit more must break the invariant
    expect(sourceExposurePreserved({
      rawBefore: 1_000_000_000n, rawRemoved: raw + 1n, decimals: 8,
      multiplierBefore: '1', multiplierAfter: '1.0064'
    })).toBe(false);
  });

  it('ignores splits and any non-increasing multiplier', () => {
    expect(dividendRawAtomic(1_000_000_000n, '1.0064', '1')).toBe(0n);   // reverse split
    expect(dividendRawAtomic(1_000_000_000n, '1', '1')).toBe(0n);        // no change
    expect(dividendRawAtomic(1_000_000_000n, '1', '0')).toBe(0n);        // nonsense
  });

  it('holds across a spread of realistic dividend sizes', () => {
    for (const m1 of ['1.0001', '1.0032', '1.0064', '1.025', '1.19']) {
      const raw = dividendRawAtomic(987_654_321n, '1', m1);
      expect(sourceExposurePreserved({
        rawBefore: 987_654_321n, rawRemoved: raw, decimals: 8,
        multiplierBefore: '1', multiplierAfter: m1
      })).toBe(true);
    }
  });

  it('never removes more than the balance', () => {
    const raw = dividendRawAtomic(1_000n, '1', '9');
    expect(raw).toBeLessThanOrEqual(1_000n);
  });

  it('verifies preservation from observed post-trade balances', () => {
    const before = 1_000_000_000n;
    const raw = dividendRawAtomic(before, '1', '1.0064');
    const good = observedExposurePreserved({
      rawBefore: before, rawAfter: before - raw, decimals: 8,
      multiplierBefore: '1', multiplierAfter: '1.0064'
    });
    expect(good.preserved).toBe(true);
    const bad = observedExposurePreserved({
      rawBefore: before, rawAfter: before - raw - 50_000n, decimals: 8,
      multiplierBefore: '1', multiplierAfter: '1.0064'
    });
    expect(bad.preserved).toBe(false);
  });
});

describe('interest harvesting', () => {
  it('never treats principal as yield', () => {
    expect(harvestableInterestUsd(10018.42, 10000, .5).toFixed(2)).toBe('17.92');
  });
  it('returns zero below the principal floor', () => {
    expect(harvestableInterestUsd(9999, 10000, .5).toFixed(0)).toBe('0');
  });
  it('scales the safety buffer with the floor', () => {
    expect(defaultSafetyBufferUsd(1000).toFixed(2)).toBe('0.50');
    expect(defaultSafetyBufferUsd(100000).toFixed(2)).toBe('50.00');
  });

  it('rejects an atomic-vs-dollar unit error before it can drain the vault', () => {
    // redeemable misread as atomic units: $10,018.42 arrives as 10,018,420,000
    const bad = harvestableInterestUsd(10_018_420_000, 10000, .5);
    expect(harvestPlausible(bad, 10_018_420_000).ok).toBe(false);
    // correctly scaled figures pass
    const good = harvestableInterestUsd(10018.42, 10000, .5);
    expect(harvestPlausible(good, 10018.42).ok).toBe(true);
  });
});

describe('exposure scaling', () => {
  it('applies the multiplier to whole units', () => {
    expect(scaledExposure(100_000_000n, 8, '1.0064').toFixed(4)).toBe('1.0064');
  });
  it('keeps precision beyond float range', () => {
    const huge = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    expect(scaledExposure(huge, 0, '1').toFixed(0)).toBe(new Decimal(huge.toString()).toFixed(0));
  });
});
