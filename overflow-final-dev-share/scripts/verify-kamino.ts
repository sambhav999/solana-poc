/**
 * Funded-position unit verification. Compare `redeemableUsd` with Kamino UI.
 * Do not sign a mainnet withdrawal until they agree to normal display rounding.
 *
 *   npm run verify:kamino -- <walletAddress>
 */
import Decimal from 'decimal.js';
import { getKaminoVaultSnapshot, sharesForWithdrawal } from '../lib/kamino';

async function main() {
  const wallet = process.argv[2];
  const vault = process.env.KAMINO_USDC_VAULT;
  if (!wallet) throw new Error('usage: npm run verify:kamino -- <walletAddress>');
  if (!vault) throw new Error('KAMINO_USDC_VAULT is not set');

  const snap = await getKaminoVaultSnapshot(vault, wallet);
  console.log('vault              ', vault);
  console.log('wallet             ', wallet);
  console.log('sharesAmount       ', snap.sharesAmount, '(human share units)');
  console.log('exchangeRate       ', snap.exchangeRate, 'USDC/share');
  console.log('derivation         ', snap.derivation);
  console.log('redeemableUsd      ', snap.redeemableUsd);
  console.log('tokenDecimals      ', snap.tokenDecimals);
  console.log('apy                ', snap.apy);
  console.log('');
  console.log('1-share redemption ', new Decimal(snap.exchangeRate).toFixed(6), 'USDC');
  console.log('shares for $1      ', sharesForWithdrawal('1', snap).toFixed(12));
  console.log('');
  console.log('REQUIRED MANUAL CHECK: redeemableUsd must match Kamino UI for this wallet.');
  console.log('If it does not, stop. Do not sign a funded withdrawal.');
}

main().catch(e => { console.error('verify:kamino failed:', e.message); process.exit(1); });
