import { Connection, PublicKey } from '@solana/web3.js';

const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
const symbol = process.env.DEMO_XSTOCK_SYMBOL || 'MRKx';
let failed = false;
const fail = (m: string) => { console.error('✕', m); failed = true; };
const ok = (m: string) => console.log('✓', m);

async function check(url: string, label: string, hard = true) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) { ok(`${label} (${r.status})`); return true; }
    if (hard) fail(`${label} → ${r.status}`);
    else console.log('!', `${label} → ${r.status}`);
  } catch (e: any) {
    hard ? fail(`${label} unreachable: ${e.message}`) : console.log('!', `${label} unreachable: ${e.message}`);
  }
  return false;
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  try {
    const c = new Connection(rpc, 'confirmed');
    ok(`Solana RPC ${(await c.getVersion())['solana-core']}`);
  } catch (e: any) { fail(`Solana RPC: ${e.message}`); }

  const vault = process.env.KAMINO_USDC_VAULT;
  if (!vault) fail('KAMINO_USDC_VAULT not set');
  else { try { new PublicKey(vault); ok(`Kamino vault parses ${vault}`); } catch { fail('KAMINO_USDC_VAULT is not a valid pubkey'); } }

  const base = (process.env.XSTOCKS_API_BASE || 'https://api.xstocks.fi/api/v2').replace(/\/+$/, '');
  await check(`${base}/public/assets/${encodeURIComponent(symbol)}`, `xStocks asset ${symbol}`);
  await check(`${base}/public/assets/${encodeURIComponent(symbol)}/multiplier?network=Solana`, 'xStocks current multiplier');
  await check(`${base}/public/assets/${encodeURIComponent(symbol)}/multiplier/history?network=Solana`, 'xStocks multiplier history');
  await check(`${base}/public/assets/${encodeURIComponent(symbol)}/price-data`, 'xStocks price data');
  const historyOk = await check(`${base}/public/corporate-actions/history`, 'xStocks corporate actions /history', false);
  if (!historyOk) await check(`${base}/public/corporate-actions`, 'xStocks corporate actions fallback', true);

  if (!process.env.JUPITER_API_KEY) {
    isProd ? fail('JUPITER_API_KEY not set') : console.log('! JUPITER_API_KEY not set');
  }
  const jbase = (process.env.JUPITER_BASE_URL || 'https://api.jup.ag').replace(/\/+$/, '');
  try {
    const j = await fetch(`${jbase}/swap/v2/order?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=1000000&taker=11111111111111111111111111111111`, {
      headers: process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {}, cache: 'no-store'
    });
    j.status < 500 ? ok(`Jupiter reachable (${j.status})`) : fail(`Jupiter ${j.status}`);
  } catch (e: any) { fail(`Jupiter unreachable: ${e.message}`); }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    isProd ? fail('Supabase not configured — production persistence is mandatory') : console.log('! Supabase not configured: local run will use memory');
  } else ok('Supabase env configured');

  if (failed) { console.error('\nPreflight failed.'); process.exit(1); }
  console.log('\nPreflight passed.');
}
main().catch(e => { console.error('Preflight failed:', e); process.exit(1); });
