import { randomUUID } from 'node:crypto';
import { getDb, nowIso } from './index.js';

const COLUMNS = `id, wallet, source_type, source_id, source_mint, source_symbol, source_decimals,
  earnings_type, destination_mint, destination_symbol, destination_decimals,
  min_execution_usd_atomic, max_slippage_bps, max_price_impact_bps, allow_overnight, status,
  principal_floor_atomic, principal_floor_source, safety_buffer_atomic, kamino_vault,
  kamino_share_mint, created_at, updated_at,
  source_raw_baseline, vault_shares_baseline, baseline_updated_at, pause_reason,
  destination_provider, destination_category, market_guard_mode, max_premium_bps, min_premium_bps`;

export function createRule(input) {
  const db = getDb();
  const id = randomUUID();
  const ts = nowIso();
  db.prepare(`INSERT INTO rules (${COLUMNS}) VALUES (
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
  )`).run(
    id, input.wallet, input.sourceType, input.sourceId, input.sourceMint ?? null,
    input.sourceSymbol ?? null, input.sourceDecimals ?? null, input.earningsType,
    input.destinationMint, input.destinationSymbol, input.destinationDecimals ?? null,
    String(input.minExecutionUsdAtomic), Number(input.maxSlippageBps),
    Number(input.maxPriceImpactBps ?? 100), input.allowOvernight ? 1 : 0, 'ACTIVE',
    input.principalFloorAtomic ? String(input.principalFloorAtomic) : null,
    input.principalFloorSource ?? null,
    input.safetyBufferAtomic ? String(input.safetyBufferAtomic) : null,
    input.kaminoVault ?? null, input.kaminoShareMint ?? null, ts, ts,
    input.sourceRawBaseline ?? null, input.vaultSharesBaseline ?? null,
    input.baselineUpdatedAt ?? null, null,
    input.destinationProvider ?? 'XSTOCKS', input.destinationCategory ?? 'PUBLIC_STOCK',
    input.marketGuardMode ?? 'NONE',
    input.maxPremiumBps ?? null, input.minPremiumBps ?? null,
  );
  return getRule(id);
}

export function getRule(id) {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM rules WHERE id = ?`).get(id);
  return row ? hydrate(row) : null;
}

export function listRules(wallet) {
  const rows = getDb().prepare(`SELECT ${COLUMNS} FROM rules WHERE wallet = ? ORDER BY created_at DESC`).all(wallet);
  return rows.map(hydrate);
}

export function listActiveDividendRules() {
  const rows = getDb().prepare(
    `SELECT ${COLUMNS} FROM rules WHERE status = 'ACTIVE' AND source_type = 'XSTOCK_DIVIDEND'`
  ).all();
  return rows.map(hydrate);
}

export function updateRule(id, patch) {
  const db = getDb();
  const allowed = {
    status: 'status',
    minExecutionUsdAtomic: 'min_execution_usd_atomic',
    maxSlippageBps: 'max_slippage_bps',
    maxPriceImpactBps: 'max_price_impact_bps',
    allowOvernight: 'allow_overnight',
    destinationMint: 'destination_mint',
    destinationSymbol: 'destination_symbol',
    destinationDecimals: 'destination_decimals',
    principalFloorAtomic: 'principal_floor_atomic',
    principalFloorSource: 'principal_floor_source',
    safetyBufferAtomic: 'safety_buffer_atomic',
    sourceRawBaseline: 'source_raw_baseline',
    vaultSharesBaseline: 'vault_shares_baseline',
    baselineUpdatedAt: 'baseline_updated_at',
    pauseReason: 'pause_reason',
    marketGuardMode: 'market_guard_mode',
    maxPremiumBps: 'max_premium_bps',
    minPremiumBps: 'min_premium_bps',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      const v = patch[key];
      values.push(typeof v === 'boolean' ? (v ? 1 : 0) : (typeof v === 'bigint' ? v.toString() : v));
    }
  }
  if (!sets.length) return getRule(id);
  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  db.prepare(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getRule(id);
}

export function deleteRule(id) {
  return getDb().prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;
}

function hydrate(row) {
  return {
    id: row.id,
    wallet: row.wallet,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceMint: row.source_mint,
    sourceSymbol: row.source_symbol,
    sourceDecimals: row.source_decimals,
    earningsType: row.earnings_type,
    destinationMint: row.destination_mint,
    destinationSymbol: row.destination_symbol,
    destinationDecimals: row.destination_decimals,
    minExecutionUsdAtomic: row.min_execution_usd_atomic,
    maxSlippageBps: row.max_slippage_bps,
    maxPriceImpactBps: row.max_price_impact_bps,
    allowOvernight: Boolean(row.allow_overnight),
    status: row.status,
    principalFloorAtomic: row.principal_floor_atomic,
    principalFloorSource: row.principal_floor_source,
    safetyBufferAtomic: row.safety_buffer_atomic,
    kaminoVault: row.kamino_vault,
    kaminoShareMint: row.kamino_share_mint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceRawBaseline: row.source_raw_baseline,
    vaultSharesBaseline: row.vault_shares_baseline,
    baselineUpdatedAt: row.baseline_updated_at,
    pauseReason: row.pause_reason,
    destinationProvider: row.destination_provider ?? 'XSTOCKS',
    destinationCategory: row.destination_category ?? 'PUBLIC_STOCK',
    marketGuardMode: row.market_guard_mode ?? 'NONE',
    maxPremiumBps: row.max_premium_bps,
    minPremiumBps: row.min_premium_bps,
  };
}
