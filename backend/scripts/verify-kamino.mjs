#!/usr/bin/env node
/**
 * Compare Overflow's view of a Kamino position against the vault itself.
 * Run this and reconcile `redeemable` against the Kamino UI BEFORE any funded run.
 * Usage: npm run verify:kamino -- <WALLET>
 */
import 'dotenv/config';
import { readPosition, sdkStatus } from '../src/adapters/kamino/vault.js';
import { usdcToSharesFloor, redeemableFromShares, harvestableAtomic, defaultSafetyBufferAtomic } from '../src/core/principal.js';

const wallet = process.argv[2];
const vault = process.env.KAMINO_USDC_VAULT;
if (!wallet) { console.error('usage: npm run verify:kamino -- <WALLET_ADDRESS>'); process.exit(1); }
if (!vault) { console.error('KAMINO_USDC_VAULT is not set'); process.exit(1); }

const usd = (a) => `${(Number(a) / 1e6).toFixed(6)} USDC`;
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log(`\nKamino verification\n  wallet ${wallet}\n  vault  ${vault}\n`);

const sdk = await sdkStatus();
check('klend-sdk loads', sdk.available, sdk.error ?? '');
if (!sdk.available) process.exit(1);

const p = await readPosition({ owner: wallet, vaultAddress: vault });
check('position reads', p.available, p.detail ?? '');
if (!p.available) process.exit(1);

console.log(`\n  shares        ${p.sharesAtomic} atomic (${p.sharesTokens} tokens)`);
console.log(`  exchangeRate  ${(Number(p.exchangeRateScaled) / 1e18).toFixed(18)} USDC/share`);
console.log(`  redeemable    ${usd(p.redeemableAtomic)}   <-- reconcile this against the Kamino UI`);
console.log(`  slot          ${p.slot}\n`);

// Round-trip: converting USDC to shares and back must never exceed the input.
if (BigInt(p.redeemableAtomic) > 0n) {
  const sample = BigInt(p.redeemableAtomic) / 10n || 1n;
  const shares = usdcToSharesFloor({ usdcAtomic: sample, shareDecimals: p.shareDecimals, exchangeRateScaled: p.exchangeRateScaled });
  const back = redeemableFromShares({ sharesAtomic: shares, shareDecimals: p.shareDecimals, exchangeRateScaled: p.exchangeRateScaled });
  check('USDC→shares→USDC never overdraws', back <= sample, `${usd(sample)} → ${shares} shares → ${usd(back)}`);
}

const floor = process.env.VERIFY_FLOOR_ATOMIC ?? p.redeemableAtomic;
const buffer = defaultSafetyBufferAtomic(floor);
const h = harvestableAtomic({ redeemableAtomic: p.redeemableAtomic, principalFloorAtomic: floor, safetyBufferAtomic: buffer });
console.log(`  against a floor of ${usd(floor)} (buffer ${usd(buffer)}): harvestable = ${usd(h)}`);
check('harvestable never exceeds value above the floor',
  BigInt(p.redeemableAtomic) - h >= BigInt(floor), 'principal stays covered');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
