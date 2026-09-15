#!/usr/bin/env node
/**
 * Deployment preflight. Verifies configuration and live dependencies before a
 * funded run. `--prod` makes production-grade settings mandatory rather than advisory.
 */
import 'dotenv/config';
import { getSlot } from '../src/adapters/solana/rpc.js';
import { sdkStatus } from '../src/adapters/kamino/vault.js';
import { getDb } from '../src/db/index.js';
import { listDestinations } from '../src/services/assets.js';
import { limiterConfig } from '../src/adapters/jupiter/client.js';

const prod = process.argv.includes('--prod');
let failures = 0, warnings = 0;
const pass = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const fail = (l, d = '') => { console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures += 1; };
const warn = (l, d = '') => { console.log(`  ${prod ? 'FAIL' : 'WARN'}  ${l}${d ? ` — ${d}` : ''}`); if (prod) failures += 1; else warnings += 1; };

console.log(`\nOverflow preflight${prod ? ' (production)' : ''}\n`);

// --- configuration ---
process.env.SOLANA_RPC_URL ? pass('SOLANA_RPC_URL set') : warn('SOLANA_RPC_URL not set', 'public RPC will rate-limit under real use');
process.env.JUPITER_API_KEY ? pass('JUPITER_API_KEY set') : warn('JUPITER_API_KEY not set', `keyless; throttled to ${limiterConfig().mainRps} req/s`);
process.env.KAMINO_USDC_VAULT ? pass('KAMINO_USDC_VAULT set', process.env.KAMINO_USDC_VAULT) : fail('KAMINO_USDC_VAULT not set');
(process.env.NETWORK ?? 'mainnet-beta') === 'mainnet-beta' ? pass('network is mainnet-beta') : warn('network is not mainnet-beta', process.env.NETWORK);

// --- live dependencies ---
const slot = await getSlot().catch((e) => ({ error: e.message }));
typeof slot === 'number' ? pass('Solana RPC reachable', `slot ${slot}`) : fail('Solana RPC unreachable', slot.error);

const kamino = await sdkStatus();
kamino.available ? pass('Kamino SDK loads') : fail('Kamino SDK unavailable', kamino.error);

const destinations = await listDestinations().catch(() => []);
const routable = destinations.filter((d) => d.tradable);
routable.length === destinations.length && destinations.length > 0
  ? pass('all destinations routable', destinations.map((d) => d.symbol).join(', '))
  : warn('some destinations unroutable', destinations.filter((d) => !d.tradable).map((d) => d.symbol).join(', ') || 'none resolved');

// --- persistence ---
try {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const required = ['rules', 'snapshots', 'receipts', 'execution_intents', 'stranded_funds'];
  const missing = required.filter((t) => !tables.includes(t));
  missing.length ? fail('schema incomplete', `missing ${missing.join(', ')}`) : pass('schema complete', `${required.length} tables`);

  const receiptCols = db.prepare('PRAGMA table_info(receipts)').all().map((c) => c.name);
  ['verification', 'verification_note', 'preserved', 'proofs_json', 'intent_id'].every((c) => receiptCols.includes(c))
    ? pass('receipts carry verification columns')
    : fail('receipts missing verification columns');

  const ruleCols = db.prepare('PRAGMA table_info(rules)').all().map((c) => c.name);
  ['source_raw_baseline', 'vault_shares_baseline', 'pause_reason'].every((c) => ruleCols.includes(c))
    ? pass('rules carry drift baselines')
    : fail('rules missing drift baseline columns');

  if (prod && (process.env.DATABASE_PATH ?? '').includes(':memory:')) fail('in-memory database in production');
} catch (e) {
  fail('database unusable', e.message);
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'PREFLIGHT PASSED'}${warnings ? ` · ${warnings} warning(s)` : ''}\n`);
process.exit(failures ? 1 : 0);
