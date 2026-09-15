/**
 * Kamino principal-floor accounting.
 *
 * The floor is a LEDGER value, moved only by confirmed user intent:
 *   deposit confirmed              -> floor += depositedUsdc
 *   principal withdrawal confirmed -> floor -= withdrawnUsdc
 * Yield harvests never move it. It is NEVER re-derived from the current value of
 * the position, because the position appreciates and re-deriving it would let the
 * floor drift upward until principal itself became harvestable.
 *
 * All amounts are USDC atomic units (6 decimals) as BigInt.
 */

import { maxBig } from './units.js';

export const USDC_DECIMALS = 6;
export const USDC_ONE = 10n ** BigInt(USDC_DECIMALS);

/** Default buffer: max($0.50, 5 bps of the floor). Absorbs exchange-rate drift between read and execution. */
export function defaultSafetyBufferAtomic(principalFloorAtomic) {
  const floor = BigInt(principalFloorAtomic);
  const relative = (floor * 5n) / 10_000n;
  const absolute = USDC_ONE / 2n;
  return maxBig(absolute, relative);
}

/** harvestable = max(0, redeemable - floor - buffer) */
export function harvestableAtomic({ redeemableAtomic, principalFloorAtomic, safetyBufferAtomic }) {
  const redeemable = BigInt(redeemableAtomic);
  const floor = BigInt(principalFloorAtomic);
  const buffer = safetyBufferAtomic === undefined
    ? defaultSafetyBufferAtomic(floor)
    : BigInt(safetyBufferAtomic);
  if (redeemable < 0n || floor < 0n || buffer < 0n) throw new Error('principal inputs must be non-negative');
  const harvestable = redeemable - floor - buffer;
  return harvestable > 0n ? harvestable : 0n;
}

/** Redeemable value of a share balance. Shares and USDC are NOT 1:1. */
export function redeemableFromShares({ sharesAtomic, shareDecimals, exchangeRateScaled }) {
  const shares = BigInt(sharesAtomic);
  const rate = BigInt(exchangeRateScaled); // USDC per share, scaled by 1e18
  // shares(atomic) * rate(1e18) -> USDC atomic
  const numerator = shares * rate;
  const divisor = 10n ** BigInt(18 + shareDecimals - USDC_DECIMALS);
  return numerator / divisor;
}

/**
 * Convert a USDC amount to the vault shares required to redeem it.
 *
 * Rounds DOWN, always. Rounding up would withdraw more than the harvestable
 * amount, which is the single most likely way for this system to spend principal.
 * The cost of rounding down is dust left earning yield, which is harmless.
 */
export function usdcToSharesFloor({ usdcAtomic, shareDecimals, exchangeRateScaled }) {
  const usdc = BigInt(usdcAtomic);
  const rate = BigInt(exchangeRateScaled);
  if (rate <= 0n) throw new Error('exchangeRateScaled must be > 0');
  const numerator = usdc * 10n ** BigInt(18 + shareDecimals - USDC_DECIMALS);
  return numerator / rate;
}

/** Floor transitions. Returns the new floor; never allows it below zero. */
export function applyDepositConfirmed(principalFloorAtomic, depositedAtomic) {
  const deposited = BigInt(depositedAtomic);
  if (deposited <= 0n) throw new Error('deposit must be positive');
  return BigInt(principalFloorAtomic) + deposited;
}

export function applyPrincipalWithdrawConfirmed(principalFloorAtomic, withdrawnAtomic) {
  const withdrawn = BigInt(withdrawnAtomic);
  if (withdrawn <= 0n) throw new Error('withdrawal must be positive');
  const next = BigInt(principalFloorAtomic) - withdrawn;
  return next > 0n ? next : 0n;
}

/** Harvests must leave the floor untouched. Exposed so callers can assert it. */
export function applyHarvestConfirmed(principalFloorAtomic) {
  return BigInt(principalFloorAtomic);
}

/** What can actually be returned if the lending leg is impaired. */
export function principalWithdrawalPlan({ principalFloorAtomic, redeemableAtomic }) {
  const floor = BigInt(principalFloorAtomic);
  const redeemable = BigInt(redeemableAtomic);
  const withdrawable = redeemable < floor ? redeemable : floor;
  const shortfall = floor > redeemable ? floor - redeemable : 0n;
  return {
    requestedAtomic: floor.toString(),
    withdrawableAtomic: withdrawable.toString(),
    shortfallAtomic: shortfall.toString(),
    fullyReturnable: shortfall === 0n,
  };
}

/**
 * Post-execution verification. After a harvest confirms, the position must still
 * cover the floor. If it does not, something took principal and the rule must be
 * halted rather than continued.
 */
export function verifyFloorStillCovered({ principalFloorAtomic, redeemableAtomicAfter }) {
  const floor = BigInt(principalFloorAtomic);
  const after = BigInt(redeemableAtomicAfter);
  if (after >= floor) return { ok: true };
  return {
    ok: false,
    reason: 'FLOOR_BREACHED_AFTER_EXECUTION',
    shortfallAtomic: (floor - after).toString(),
  };
}
