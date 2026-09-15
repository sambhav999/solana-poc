import { randomUUID } from 'node:crypto';
import { getDb, nowIso } from './index.js';

export function upsertSnapshot(s) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM snapshots WHERE rule_id = ? AND corporate_action_id = ?')
    .get(s.ruleId, s.corporateActionId);
  if (existing) return getSnapshot(existing.id);

  const id = randomUUID();
  db.prepare(`INSERT INTO snapshots
    (id, rule_id, wallet, symbol, mint, corporate_action_id, reason, raw_balance_atomic,
     multiplier_before, multiplier_after, activation_datetime, snapshot_slot, processed, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(
    id, s.ruleId, s.wallet, s.symbol, s.mint, s.corporateActionId, s.reason,
    String(s.rawBalanceAtomic), String(s.multiplierBefore), String(s.multiplierAfter),
    s.activationDateTime, s.snapshotSlot != null ? String(s.snapshotSlot) : null, nowIso(),
  );
  return getSnapshot(id);
}

export function getSnapshot(id) {
  const row = getDb().prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

/** The pending, unprocessed snapshot for a rule, if any. */
export function getOpenSnapshotForRule(ruleId) {
  const row = getDb().prepare(
    'SELECT * FROM snapshots WHERE rule_id = ? AND processed = 0 ORDER BY activation_datetime DESC LIMIT 1'
  ).get(ruleId);
  return row ? hydrate(row) : null;
}

export function markSnapshotProcessed(id) {
  getDb().prepare('UPDATE snapshots SET processed = 1 WHERE id = ?').run(id);
}

export function listSnapshots(ruleId) {
  return getDb().prepare('SELECT * FROM snapshots WHERE rule_id = ? ORDER BY activation_datetime DESC').all(ruleId).map(hydrate);
}

function hydrate(row) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    wallet: row.wallet,
    symbol: row.symbol,
    mint: row.mint,
    corporateActionId: row.corporate_action_id,
    reason: row.reason,
    rawBalanceAtomic: row.raw_balance_atomic,
    multiplierBefore: row.multiplier_before,
    multiplierAfter: row.multiplier_after,
    activationDateTime: row.activation_datetime,
    snapshotSlot: row.snapshot_slot,
    processed: Boolean(row.processed),
    createdAt: row.created_at,
  };
}
