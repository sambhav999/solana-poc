import { randomUUID } from 'node:crypto';
import { getDb, nowIso } from './index.js';

/**
 * Capital Firewall decisions.
 *
 * Keyed by `intent_key`, which is unique: re-evaluating the SAME attempt updates
 * its decision instead of adding another row. Without that, every page refresh
 * of a blocked rule would count its earnings as "retained" again, and the
 * headline figure would grow for no reason.
 */
export function recordDecision(d) {
  const db = getDb();
  const ts = nowIso();
  const existing = db.prepare('SELECT id FROM policy_decisions WHERE intent_key = ?').get(d.intentKey);
  if (existing) {
    db.prepare(`UPDATE policy_decisions SET outcome = ?, earnings_usd_atomic = ?, evidence_json = ?, updated_at = ?
                WHERE id = ?`).run(d.outcome, String(d.earningsUsdAtomic), JSON.stringify(d.evidence), ts, existing.id);
    return getDecision(existing.id);
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO policy_decisions
    (id, wallet, rule_id, intent_key, destination_symbol, destination_provider, destination_category,
     outcome, earnings_usd_atomic, evidence_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, d.wallet, d.ruleId, d.intentKey, d.destinationSymbol, d.destinationProvider,
    d.destinationCategory, d.outcome, String(d.earningsUsdAtomic), JSON.stringify(d.evidence), ts, ts,
  );
  return getDecision(id);
}

export function getDecision(id) {
  const r = getDb().prepare('SELECT * FROM policy_decisions WHERE id = ?').get(id);
  return r ? hydrate(r) : null;
}

export function listDecisions(wallet, limit = 100) {
  return getDb().prepare('SELECT * FROM policy_decisions WHERE wallet = ? ORDER BY updated_at DESC LIMIT ?')
    .all(wallet, limit).map(hydrate);
}

/**
 * Earnings retained: value the firewall declined to spend. Summed from BLOCKED
 * decision records, so every dollar in the figure traces to one auditable row.
 */
export function earningsRetained(wallet) {
  // A block for missing data (rate limit, outage) is recorded, but it is not a
  // judgement about price, so it does not count as earnings the firewall kept.
  const rows = getDb().prepare(
    "SELECT earnings_usd_atomic, destination_category, evidence_json FROM policy_decisions WHERE wallet = ? AND outcome = 'BLOCKED'"
  ).all(wallet).filter((r) => {
    try { return JSON.parse(r.evidence_json).countsAsRetained === true; } catch { return false; }
  });
  const total = rows.reduce((s, r) => s + BigInt(r.earnings_usd_atomic), 0n);
  const byCategory = {};
  for (const r of rows) byCategory[r.destination_category] = ((BigInt(byCategory[r.destination_category] ?? '0')) + BigInt(r.earnings_usd_atomic)).toString();
  return { totalAtomic: total.toString(), blockedCount: rows.length, byCategory };
}

function hydrate(r) {
  let evidence = {};
  try { evidence = JSON.parse(r.evidence_json); } catch { /* keep empty */ }
  return {
    id: r.id, wallet: r.wallet, ruleId: r.rule_id, intentKey: r.intent_key,
    destinationSymbol: r.destination_symbol, destinationProvider: r.destination_provider,
    destinationCategory: r.destination_category, outcome: r.outcome,
    earningsUsdAtomic: r.earnings_usd_atomic, evidence,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
