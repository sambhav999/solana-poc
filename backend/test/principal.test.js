import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harvestableAtomic, defaultSafetyBufferAtomic, redeemableFromShares, usdcToSharesFloor,
  applyDepositConfirmed, applyPrincipalWithdrawConfirmed, applyHarvestConfirmed,
  principalWithdrawalPlan, verifyFloorStillCovered, USDC_ONE,
} from '../src/core/principal.js';

const usdc = (n) => BigInt(Math.round(n * 1e6));

test('harvestable is value above floor plus buffer, never negative', () => {
  const floor = usdc(10_000);
  assert.equal(harvestableAtomic({ redeemableAtomic: usdc(10_018.92), principalFloorAtomic: floor, safetyBufferAtomic: usdc(0.5) }), usdc(18.42));
  assert.equal(harvestableAtomic({ redeemableAtomic: usdc(9_990), principalFloorAtomic: floor, safetyBufferAtomic: usdc(0.5) }), 0n);
  assert.equal(harvestableAtomic({ redeemableAtomic: floor, principalFloorAtomic: floor, safetyBufferAtomic: 0n }), 0n);
});

test('default buffer is max($0.50, 5bps of floor)', () => {
  assert.equal(defaultSafetyBufferAtomic(usdc(100)), USDC_ONE / 2n);      // 5bps = $0.05 -> floor at $0.50
  assert.equal(defaultSafetyBufferAtomic(usdc(10_000)), usdc(5));          // 5bps = $5.00
});

test('the floor moves only on confirmed user intent', () => {
  let floor = 0n;
  floor = applyDepositConfirmed(floor, usdc(10_000));
  assert.equal(floor, usdc(10_000));
  // Many harvests, of any size, must not move it.
  for (let i = 0; i < 50; i++) floor = applyHarvestConfirmed(floor);
  assert.equal(floor, usdc(10_000), 'harvests must never move the principal floor');
  floor = applyDepositConfirmed(floor, usdc(2_500));
  assert.equal(floor, usdc(12_500));
  floor = applyPrincipalWithdrawConfirmed(floor, usdc(5_000));
  assert.equal(floor, usdc(7_500));
});

test('the floor is never re-derived from an appreciated position', () => {
  // The regression this guards: a position that grows must not drag the floor up,
  // or principal itself eventually becomes "harvestable".
  const floor = usdc(10_000);
  let redeemable = floor;
  let totalHarvested = 0n;
  for (let week = 0; week < 52; week++) {
    redeemable += usdc(12.3); // weekly interest
    const h = harvestableAtomic({ redeemableAtomic: redeemable, principalFloorAtomic: floor, safetyBufferAtomic: usdc(5) });
    if (h > 0n) { redeemable -= h; totalHarvested += h; }
    assert.ok(redeemable >= floor, `principal breached in week ${week}`);
  }
  assert.ok(totalHarvested > usdc(600), 'a year of interest should have been routed');
  assert.equal(applyHarvestConfirmed(floor), usdc(10_000));
});

test('share conversion rounds DOWN so a harvest can never overdraw principal', () => {
  const rate = 1_018_420_000_000_000_000n; // 1.01842 USDC/share, scaled 1e18
  const shares = usdcToSharesFloor({ usdcAtomic: usdc(18.42), shareDecimals: 6, exchangeRateScaled: rate });
  const backToUsdc = redeemableFromShares({ sharesAtomic: shares, shareDecimals: 6, exchangeRateScaled: rate });
  assert.ok(backToUsdc <= usdc(18.42), 'redeeming the computed shares must never exceed the requested amount');
  assert.ok(usdc(18.42) - backToUsdc < 100n, 'dust left behind should be negligible');
});

test('shares and USDC are not 1:1', () => {
  const rate = 1_018_420_000_000_000_000n;
  const redeemable = redeemableFromShares({ sharesAtomic: usdc(1000), shareDecimals: 6, exchangeRateScaled: rate });
  assert.equal(redeemable, usdc(1018.42));
});

test('impaired position reports a real shortfall instead of claiming a guarantee', () => {
  const plan = principalWithdrawalPlan({ principalFloorAtomic: usdc(10_000), redeemableAtomic: usdc(9_800) });
  assert.equal(plan.withdrawableAtomic, usdc(9_800).toString());
  assert.equal(plan.shortfallAtomic, usdc(200).toString());
  assert.equal(plan.fullyReturnable, false);

  const healthy = principalWithdrawalPlan({ principalFloorAtomic: usdc(10_000), redeemableAtomic: usdc(10_050) });
  assert.equal(healthy.withdrawableAtomic, usdc(10_000).toString());
  assert.equal(healthy.fullyReturnable, true);
});

test('post-execution verification catches a breached floor', () => {
  assert.equal(verifyFloorStillCovered({ principalFloorAtomic: usdc(10_000), redeemableAtomicAfter: usdc(10_001) }).ok, true);
  const bad = verifyFloorStillCovered({ principalFloorAtomic: usdc(10_000), redeemableAtomicAfter: usdc(9_999) });
  assert.equal(bad.ok, false);
  assert.equal(bad.shortfallAtomic, usdc(1).toString());
});
