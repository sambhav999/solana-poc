/** Verify every xStocks API boundary Overflow uses and print the latest DVCA candidate. */
import {
  corporateActions, latestCashDividend, multiplierHistory, currentMultiplierState,
  solanaMintFor, assetPriceUsd, resolveMultiplierPair,
} from '../lib/xstocks';

async function main() {
  const symbol = process.argv[2] || process.env.DEMO_XSTOCK_SYMBOL || 'MRKx';
  console.log('xStocks base:', process.env.XSTOCKS_API_BASE || 'https://api.xstocks.fi/api/v2');
  console.log('symbol      :', symbol);

  const mint = await solanaMintFor(symbol);
  console.log('Solana mint :', mint);
  const price = await assetPriceUsd(symbol);
  console.log('price USD   :', price.toFixed(6));
  const current = await currentMultiplierState(symbol);
  console.log('multiplier  :', current.multiplier, 'activation:', current.activationAt || 'n/a');
  const hist = await multiplierHistory(symbol);
  console.log('history rows:', hist.length);
  const actions = await corporateActions();
  console.log('corp actions:', actions.length);
  const dvca = await latestCashDividend(symbol);
  if (!dvca) {
    console.log('latest DVCA : none found for', symbol);
    console.log('Replay Mode will be required unless another supported symbol has a suitable event.');
    return;
  }
  console.log('latest DVCA :', dvca.eventId, dvca.effectiveAt);
  const pair = await resolveMultiplierPair(symbol, dvca.eventId);
  console.log('exact pair  :', pair ? `${pair.m0} -> ${pair.m1} @ ${pair.activationAt || 'n/a'}` : 'NO EXACT MATCH');
  if (!pair) process.exitCode = 2;
}

main().catch(e => { console.error('verify:xstocks failed:', e.message); process.exit(1); });
