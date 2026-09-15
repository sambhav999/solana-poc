import { randomUUID } from 'node:crypto';
import { getDb, nowIso } from './index.js';

/**
 * Execution intents.
 *
 * An intent is what the SERVER authorised: which mints, how much, and the hash
 * of the exact transaction message it prepared. Signing happens in the browser,
 * so without this record there is nothing to check a returned transaction
 * against.
 *
 * It also makes a harvest resumable: if the Kamino withdrawal lands but the swap
 * does not, the same intent carries the verified withdrawn amount forward
 * instead of preparing a second withdrawal.
 */
const COLS = `id, rule_id, wallet, kind, stage, execution_key, message_hash, jupiter_request_id,
  authorised_raw, source_mint, destination_mint, snapshot_json, withdrawn_raw, status,
  created_at, updated_at`;

export function createIntent(input) {
  const db = getDb();
  const id = randomUUID();
  const ts = nowIso();
  db.prepare(`INSERT INTO execution_intents (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.ruleId, input.wallet, input.kind, input.stage, input.executionKey,
    input.messageHash ?? null, input.jupiterRequestId ?? null,
    input.authorisedRaw != null ? String(input.authorisedRaw) : null,
    input.sourceMint ?? null, input.destinationMint ?? null,
    input.snapshot ? JSON.stringify(input.snapshot) : null,
    input.withdrawnRaw != null ? String(input.withdrawnRaw) : null,
    'OPEN', ts, ts,
  );
  return getIntent(id);
}

export function getIntent(id) {
  const row = getDb().prepare(`SELECT ${COLS} FROM execution_intents WHERE id = ?`).get(id);
  return row ? hydrate(row) : null;
}

/** The open intent for a rule, if a previous attempt left one mid-flight. */
export function getOpenIntent(ruleId) {
  const row = getDb().prepare(
    `SELECT ${COLS} FROM execution_intents WHERE rule_id = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1`
  ).get(ruleId);
  return row ? hydrate(row) : null;
}

export function updateIntent(id, patch) {
  const map = {
    stage: 'stage', messageHash: 'message_hash', jupiterRequestId: 'jupiter_request_id',
    authorisedRaw: 'authorised_raw', withdrawnRaw: 'withdrawn_raw', status: 'status',
    sourceMint: 'source_mint', destinationMint: 'destination_mint',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(patch[key] === null ? null : String(patch[key]));
    }
  }
  if (patch.snapshot !== undefined) { sets.push('snapshot_json = ?'); values.push(JSON.stringify(patch.snapshot)); }
  if (!sets.length) return getIntent(id);
  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  getDb().prepare(`UPDATE execution_intents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getIntent(id);
}

export function consumeIntent(id) { return updateIntent(id, { status: 'CONSUMED', stage: 'DONE' }); }
export function abandonIntent(id) { return updateIntent(id, { status: 'ABANDONED' }); }

function hydrate(r) {
  return {
    id: r.id, ruleId: r.rule_id, wallet: r.wallet, kind: r.kind, stage: r.stage,
    executionKey: r.execution_key, messageHash: r.message_hash, jupiterRequestId: r.jupiter_request_id,
    authorisedRaw: r.authorised_raw, sourceMint: r.source_mint, destinationMint: r.destination_mint,
    snapshot: r.snapshot_json ? safeParse(r.snapshot_json) : null,
    withdrawnRaw: r.withdrawn_raw, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
