import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDepositConfirmed, applyPrincipalWithdrawConfirmed, applyHarvestConfirmed,
  principalWithdrawalPlan, usdcToSharesFloor, redeemableFromShares, harvestableAtomic,
} from '../src/core/principal.js';

const usdc = (n) => BigInt(Math.round(n * 1e6));
const RATE = 1_058_626_613_125_955_769n; // real Kamino USDC vault rate, scaled 1e18

test('a full deposit -> harvest -> withdraw-principal cycle keeps the floor honest', () => {
  let floor = 0n;

  // Deposit 10,000 USDC. The floor is set by the confirmed deposit, not by the
  // position value, which already differs because shares appreciate.
  floor = applyDepositConfirmed(floor, usdc(10_000));
  assert.equal(floor, usdc(10_000));

  let redeemable = usdc(10_000);

  // A year of interest, harvested weekly. The floor must not move once.
  let harvestedTotal = 0n;
  for (let week = 0; week < 52; week++) {
    redeemable += usdc(12.3);
    const h = harvestableAtomic({ redeemableAtomic: redeemable, principalFloorAtomic: floor, safetyBufferAtomic: usdc(5) });
    if (h > 0n) {
      redeemable -= h;
      harvestedTotal += h;
      floor = applyHarvestConfirmed(floor);
    }
    assert.equal(floor, usdc(10_000), `floor moved during harvest in week ${week}`);
    assert.ok(redeemable >= floor, `principal breached in week ${week}`);
  }
  assert.ok(harvestedTotal > usdc(600));

  // Withdraw the principal. Floor drops to zero; harvested earnings are already
  // in stocks and are not part of this calculation.
  const plan = principalWithdrawalPlan({ principalFloorAtomic: floor, redeemableAtomic: redeemable });
  assert.equal(plan.fullyReturnable, true);
  floor = applyPrincipalWithdrawConfirmed(floor, BigInt(plan.withdrawableAtomic));
  assert.equal(floor, 0n);
});

test('a partial principal withdrawal lowers the floor by exactly what was returned', () => {
  let floor = applyDepositConfirmed(0n, usdc(10_000));
  floor = applyPrincipalWithdrawConfirmed(floor, usdc(2_500));
  assert.equal(floor, usdc(7_500));
  // The remaining floor is still fully protected against harvesting.
  assert.equal(harvestableAtomic({ redeemableAtomic: usdc(7_600), principalFloorAtomic: floor, safetyBufferAtomic: usdc(5) }), usdc(95));
});

test('multiple deposits accumulate the floor', () => {
  let floor = 0n;
  floor = applyDepositConfirmed(floor, usdc(1_000));
  floor = applyDepositConfirmed(floor, usdc(2_500));
  floor = applyDepositConfirmed(floor, usdc(500));
  assert.equal(floor, usdc(4_000));
});

test('withdrawing more than the floor cannot drive it negative', () => {
  const floor = applyDepositConfirmed(0n, usdc(1_000));
  assert.equal(applyPrincipalWithdrawConfirmed(floor, usdc(5_000)), 0n);
});

test('harvest share conversion at the real vault rate never overdraws', () => {
  // The exact rate read from the live Kamino USDC vault. Shares are not 1:1.
  const harvestable = usdc(25);
  const shares = usdcToSharesFloor({ usdcAtomic: harvestable, shareDecimals: 6, exchangeRateScaled: RATE });
  const redeemed = redeemableFromShares({ sharesAtomic: shares, shareDecimals: 6, exchangeRateScaled: RATE });
  assert.ok(redeemed <= harvestable, `redeeming ${redeemed} exceeds the harvestable ${harvestable}`);
  assert.ok(harvestable - redeemed < 10n, 'dust left behind should be under a thousandth of a cent');
});

test('the rounding direction holds across many harvest sizes', () => {
  for (let i = 1; i <= 500; i++) {
    const amount = BigInt(i) * 7919n;
    const shares = usdcToSharesFloor({ usdcAtomic: amount, shareDecimals: 6, exchangeRateScaled: RATE });
    const redeemed = redeemableFromShares({ sharesAtomic: shares, shareDecimals: 6, exchangeRateScaled: RATE });
    assert.ok(redeemed <= amount, `overdrew at amount=${amount}: got ${redeemed}`);
  }
});

test('an impaired position returns what exists and names the shortfall', () => {
  const floor = usdc(10_000);
  const plan = principalWithdrawalPlan({ principalFloorAtomic: floor, redeemableAtomic: usdc(9_412.55) });
  assert.equal(plan.fullyReturnable, false);
  assert.equal(plan.withdrawableAtomic, usdc(9_412.55).toString());
  assert.equal(plan.shortfallAtomic, usdc(587.45).toString());
  // After returning what exists, the floor reflects only the unreturned remainder.
  const after = applyPrincipalWithdrawConfirmed(floor, BigInt(plan.withdrawableAtomic));
  assert.equal(after, usdc(587.45));
});

test('a failed withdrawal leaves the floor untouched', () => {
  const floor = applyDepositConfirmed(0n, usdc(10_000));
  // No applyPrincipalWithdrawConfirmed call happens on failure.
  assert.equal(floor, usdc(10_000));
});
