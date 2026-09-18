#!/usr/bin/env node
/**
 * Static audit. Each check encodes a failure that actually happened while
 * building Overflow, so it cannot quietly come back.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const REPO = resolve(ROOT, '..');
let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m, where = []) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
  where.slice(0, 8).forEach((w) => console.log(`          ${w}`));
};

function walk(dir, exts) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist' || name === 'data') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}
const read = (f) => readFileSync(f, 'utf8');
const rel = (f) => relative(REPO, f);
/** Code only: strip comments so a WARNING in prose does not trip a check. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const backend = walk(join(ROOT, 'src'), ['.js']);
const frontend = walk(join(REPO, 'frontend', 'src'), ['.js', '.jsx']);
console.log(`\nOverflow static audit — ${backend.length} backend, ${frontend.length} frontend files\n`);

// 1. Local imports resolve.
const missing = [];
for (const f of [...backend, ...frontend]) {
  for (const m of read(f).matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!existsSync(resolve(dirname(f), m[1]))) missing.push(`${rel(f)} -> ${m[1]}`);
  }
}
missing.length ? bad('local imports resolve', missing) : ok('local imports resolve');

// 2. No endpoint takes its wallet from the request (it must come from a session).
const routes = read(join(ROOT, 'src/routes/index.js'));
const walletFromRequest = [...code(routes).matchAll(/req\.query\.wallet|req\.body\?\.wallet/g)];
walletFromRequest.length
  ? bad('no endpoint trusts a wallet from the request', walletFromRequest.map((m) => m[0]))
  : ok('no endpoint trusts a wallet from the request (session only)');

// 3. Every /rules/:id route checks ownership.
const ruleRoutes = [...routes.matchAll(/router\.(get|post|patch|delete)\('(\/rules\/:id[^']*)'[\s\S]*?\n\}\)\);/g)];
const unowned = ruleRoutes.filter((m) => !/ownedRule\(req, res\)/.test(m[0])).map((m) => `${m[1].toUpperCase()} ${m[2]}`);
unowned.length ? bad('every /rules/:id route checks ownership', unowned) : ok(`every /rules/:id route checks ownership (${ruleRoutes.length} routes)`);

// 4. Mints are resolved server-side, never taken from the client.
const clientMint = [...code(routes).matchAll(/(destinationMint|sourceMint):\s*b\.(destinationMint|sourceMint)/g)];
clientMint.length ? bad('mints are resolved server-side', clientMint.map((m) => m[0])) : ok('mints are resolved server-side');

// 5. No float arithmetic in the money core.
const CORE = ['core/dividend.js', 'core/principal.js', 'core/units.js', 'core/marketGuard.js'];
const floaty = [];
for (const f of CORE) {
  const src = code(read(join(ROOT, 'src', f)));
  for (const m of src.matchAll(/\bparseFloat\(|\bMath\.(round|floor|ceil)\(|\btoFixed\(/g)) floaty.push(`src/${f}: ${m[0]}`);
}
floaty.length ? bad('money core is BigInt-only (no float rounding)', floaty) : ok('money core is BigInt-only (no float rounding)');

// 6. No hard-coded preservation claim.
const hardcoded = backend.filter((f) => /preserved:\s*true\b/.test(code(read(f)))).map(rel);
hardcoded.length ? bad('no hard-coded "preserved: true"', hardcoded) : ok('no hard-coded "preserved: true" (receipts are verified)');

// 7. Legacy / wrong xStocks host.
const legacy = [...backend, ...frontend].filter((f) => /api\.xstocks\.com/.test(read(f))).map(rel);
legacy.length ? bad('no legacy api.xstocks.com host', legacy) : ok('no legacy api.xstocks.com host');

// 8. No server secret referenced by frontend code.
const leaked = frontend.filter((f) => /JUPITER_API_KEY|SESSION_SECRET|PYTH_API_KEY|CRON_SECRET/.test(read(f))).map(rel);
leaked.length ? bad('no server secret referenced in the frontend bundle', leaked) : ok('no server secret referenced in the frontend bundle');

// 9. The firewall runs BEFORE the Kamino withdrawal.
const exec = code(read(join(ROOT, 'src/services/execute.js')));
const fwAt = exec.indexOf('runFirewall(');
const wdAt = exec.indexOf('prepareHarvestWithdrawal(');
fwAt !== -1 && wdAt !== -1 && fwAt < wdAt
  ? ok('Capital Firewall runs before the Kamino withdrawal')
  : bad('Capital Firewall runs before the Kamino withdrawal');

// 10. Preview is side-effect free.
const preview = code(read(join(ROOT, 'src/services/preview.js')));
/dryRun:\s*true/.test(preview) && !/recordDecision|createReceipt|createIntent/.test(preview)
  ? ok('preview is a dry run (records nothing)')
  : bad('preview is a dry run (records nothing)');

// 11. Intent binding fails closed.
/INTENT_REQUIRED/.test(exec) && /INTENT_NOT_FOUND/.test(exec) && /SIGNED_MESSAGE_MISMATCH/.test(exec)
  ? ok('signed-transaction binding fails closed')
  : bad('signed-transaction binding fails closed');

// 12. Corporate actions: 1-based pagination and float64-aware binding.
const ca = code(read(join(ROOT, 'src/adapters/xstocks/corporateActionsFeed.js')));
/page = 1/.test(ca) && /float64Equal/.test(ca) && /cancelled/i.test(ca)
  ? ok('corporate actions: 1-based pages, float64-aware bind, cancelled refused')
  : bad('corporate actions: 1-based pages, float64-aware bind, cancelled refused');

// 13. Env files are not tracked by git.
try {
  const tracked = execSync('git ls-files', { cwd: REPO }).toString().split('\n').filter((f) => /(^|\/)\.env(\.local)?$/.test(f));
  tracked.length ? bad('.env files are not committed', tracked) : ok('.env files are not committed');
} catch { ok('.env files are not committed (not a git checkout)'); }

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'STATIC AUDIT PASSED'}\n`);
process.exit(failures ? 1 : 0);
