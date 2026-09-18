import { randomUUID } from 'node:crypto';
import { getDb, nowIso } from './index.js';

/**
 * A receipt stores the full computation, not just what was displayed. If the
 * numbers on screen cannot be re-derived from the stored inputs, the receipt is
 * not proof of anything.
 */
export function createReceipt(r) {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`INSERT INTO receipts
    (id, rule_id, wallet, kind, mode, status, execution_key, signature, slot,
     inputs_json, outputs_json, quote_json, error, created_at,
     verification, verification_note, preserved, proofs_json, intent_id,
     destination_category, destination_symbol, earnings_usd_atomic)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, r.ruleId, r.wallet, r.kind, r.mode, r.status, r.executionKey,
    r.signature ?? null, r.slot != null ? String(r.slot) : null,
    JSON.stringify(r.inputs ?? {}), JSON.stringify(r.outputs ?? {}),
    r.quote ? JSON.stringify(r.quote) : null, r.error ?? null, nowIso(),
    r.verification ?? null, r.verificationNote ?? null,
    r.preserved === undefined ? null : (r.preserved ? 1 : 0),
    r.proofs ? JSON.stringify(r.proofs) : null, r.intentId ?? null,
    r.destinationCategory ?? null, r.destinationSymbol ?? null,
    r.earningsUsdAtomic != null ? String(r.earningsUsdAtomic) : null,
  );
  return getReceipt(id);
}

export function getReceipt(id) {
  const row = getDb().prepare('SELECT * FROM receipts WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

export function listReceipts(wallet, limit = 50) {
  return getDb().prepare('SELECT * FROM receipts WHERE wallet = ? ORDER BY created_at DESC LIMIT ?')
    .all(wallet, limit).map(hydrate);
}

export function listReceiptsForRule(ruleId, limit = 50) {
  return getDb().prepare('SELECT * FROM receipts WHERE rule_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(ruleId, limit).map(hydrate);
}

/** Has this exact execution already confirmed? The idempotency check. */
export function hasConfirmedExecution(executionKey) {
  const row = getDb().prepare(
    "SELECT id FROM receipts WHERE execution_key = ? AND status = 'CONFIRMED' LIMIT 1"
  ).get(executionKey);
  return Boolean(row);
}

function hydrate(row) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    wallet: row.wallet,
    kind: row.kind,
    mode: row.mode,
    status: row.status,
    executionKey: row.execution_key,
    signature: row.signature,
    slot: row.slot,
    inputs: safeParse(row.inputs_json),
    outputs: safeParse(row.outputs_json),
    quote: row.quote_json ? safeParse(row.quote_json) : null,
    error: row.error,
    createdAt: row.created_at,
    verification: row.verification,
    verificationNote: row.verification_note,
    preserved: row.preserved === null ? null : Boolean(row.preserved),
    proofs: row.proofs_json ? safeParse(row.proofs_json) : null,
    intentId: row.intent_id,
    destinationCategory: row.destination_category,
    destinationSymbol: row.destination_symbol,
    earningsUsdAtomic: row.earnings_usd_atomic,
    explorerUrl: row.signature ? `https://solscan.io/tx/${row.signature}` : null,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }
