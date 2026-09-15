import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

/**
 * Raw Token-2022 units attributable only to a positive xStocks multiplier increase.
 *
 * Scaled exposure is `raw * multiplier`. To route the dividend while keeping the
 * pre-event exposure we need the largest `removed` satisfying:
 *
 *     (raw - removed) * m1 >= raw * m0
 *  => removed          <= raw * (m1 - m0) / m1
 *
 * Flooring is what guarantees the inequality holds, so the source is preserved
 * rather than shaved. Never change this to round().
 */
export function dividendRawAtomic(
  rawBalanceAtomic: bigint,
  multiplierBefore: string | number,
  multiplierAfter: string | number
): bigint {
  const m0 = new Decimal(multiplierBefore);
  const m1 = new Decimal(multiplierAfter);
  if (m0.lte(0) || m1.lte(0) || m1.lte(m0)) return 0n;
  const raw = new Decimal(rawBalanceAtomic.toString());
  return BigInt(raw.mul(m1.sub(m0)).div(m1).floor().toFixed(0));
}

export function scaledExposure(
  rawAtomic: bigint,
  decimals: number,
  multiplier: string | number
): Decimal {
  return new Decimal(rawAtomic.toString())
    .div(new Decimal(10).pow(decimals))
    .mul(multiplier);
}

/**
 * Strict invariant. `dividendRawAtomic` floors, so this must hold exactly —
 * no tolerance. A tolerance here would only let a real violation through.
 *
 * Note this proves internal consistency of (raw, m0, m1). It cannot detect a
 * wrong multiplier pair, which is why the engine resolves m0/m1 by exact event
 * id and refuses to guess.
 */
export function sourceExposurePreserved(args: {
  rawBefore: bigint;
  rawRemoved: bigint;
  decimals: number;
  multiplierBefore: string | number;
  multiplierAfter: string | number;
}): boolean {
  if (args.rawRemoved < 0n || args.rawRemoved > args.rawBefore) return false;
  const before = scaledExposure(args.rawBefore, args.decimals, args.multiplierBefore);
  const after = scaledExposure(args.rawBefore - args.rawRemoved, args.decimals, args.multiplierAfter);
  return after.gte(before);
}

/** Same invariant, checked against balances actually observed on chain after the swap. */
export function observedExposurePreserved(args: {
  rawBefore: bigint;
  rawAfter: bigint;
  decimals: number;
  multiplierBefore: string | number;
  multiplierAfter: string | number;
}): { preserved: boolean; exposureBefore: string; exposureAfter: string } {
  const before = scaledExposure(args.rawBefore, args.decimals, args.multiplierBefore);
  const after = scaledExposure(args.rawAfter, args.decimals, args.multiplierAfter);
  return {
    preserved: after.gte(before),
    exposureBefore: before.toFixed(8),
    exposureAfter: after.toFixed(8)
  };
}

export function harvestableInterestUsd(
  redeemableUsd: string | number,
  principalFloorUsd: string | number,
  safetyBufferUsd: string | number
): Decimal {
  return Decimal.max(
    0,
    new Decimal(redeemableUsd).sub(principalFloorUsd).sub(safetyBufferUsd)
  );
}

export function defaultSafetyBufferUsd(principalFloorUsd: string | number): Decimal {
  return Decimal.max(new Decimal('0.5'), new Decimal(principalFloorUsd).mul('0.0005'));
}

/**
 * Unit sanity guard for the Kamino path.
 *
 * The failure mode this exists for: if `redeemableUsd` is read in atomic units
 * instead of dollars, harvestable becomes ~1e6x the real figure, clears every
 * threshold, and the rule tries to withdraw the whole position. The principal
 * floor cannot catch that, because the floor is subtracted from the bad number.
 *
 * A single interest harvest should never be a large fraction of the position.
 */
export function harvestPlausible(
  harvestableUsd: Decimal,
  redeemableUsd: string | number,
  maxFraction = 0.25
): { ok: boolean; fraction: string } {
  const redeemable = new Decimal(redeemableUsd);
  if (redeemable.lte(0)) return { ok: false, fraction: '0' };
  const fraction = harvestableUsd.div(redeemable);
  return { ok: fraction.lte(maxFraction), fraction: fraction.toFixed(6) };
}
