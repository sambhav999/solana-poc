import { randomUUID } from 'node:crypto';
import { getDb, nowIso } from './index.js';

/**
 * Funds left in the wallet by a partially completed execution.
 *
 * The interest rule withdraws USDC from Kamino BEFORE swapping. If the swap then
 * fails, that USDC is sitting in the user's wallet: it is neither principal nor
 * a completed harvest. It is recorded here so the next execution sweeps it first
 * rather than withdrawing more on top of it.
 */
export function recordStranded({ ruleId, wallet, mint, rawAtomic, origin }) {
  const id = randomUUID();
  getDb().prepare(
    'INSERT INTO stranded_funds (id, rule_id, wallet, mint, raw_atomic, origin, swept, created_at) VALUES (?,?,?,?,?,?,0,?)'
  ).run(id, ruleId, wallet, mint, String(rawAtomic), origin, nowIso());
  return id;
}

export function listStranded(ruleId) {
  return getDb().prepare('SELECT * FROM stranded_funds WHERE rule_id = ? AND swept = 0').all(ruleId)
    .map((r) => ({ id: r.id, ruleId: r.rule_id, wallet: r.wallet, mint: r.mint, rawAtomic: r.raw_atomic, origin: r.origin, createdAt: r.created_at }));
}

export function totalStrandedAtomic(ruleId, mint) {
  const rows = getDb().prepare('SELECT raw_atomic FROM stranded_funds WHERE rule_id = ? AND mint = ? AND swept = 0').all(ruleId, mint);
  return rows.reduce((sum, r) => sum + BigInt(r.raw_atomic), 0n);
}

export function markSwept(ids) {
  const db = getDb();
  const stmt = db.prepare('UPDATE stranded_funds SET swept = 1 WHERE id = ?');
  for (const id of ids) stmt.run(id);
}
