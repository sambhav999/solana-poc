/**
 * Persistence. Uses node:sqlite, which ships with Node 22+, so there is no
 * native build step and no external database to stand up for a demo.
 *
 * What must survive a refresh, a reconnect, or a different device:
 *   - the principal floor (losing it would let a harvest spend principal)
 *   - pre-event dividend snapshots (the entitlement basis)
 *   - receipts and their transaction signatures (the proof)
 *   - execution keys (so nothing runs twice)
 *
 * Every numeric column that can reach a transaction is TEXT, holding an exact
 * integer or decimal string. SQLite's REAL type is a float and must never hold
 * one of these values.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let db;

export function getDb() {
  if (db) return db;
  const file = process.env.DATABASE_PATH || resolve(process.cwd(), 'data/overflow.db');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  addColumns(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      source_type TEXT NOT NULL,          -- KAMINO_USDC | XSTOCK_DIVIDEND
      source_id TEXT NOT NULL,            -- vault address or xStock symbol
      source_mint TEXT,
      source_symbol TEXT,
      source_decimals INTEGER,
      earnings_type TEXT NOT NULL,        -- INTEREST | DIVIDEND
      destination_mint TEXT NOT NULL,
      destination_symbol TEXT NOT NULL,
      destination_decimals INTEGER,
      min_execution_usd_atomic TEXT NOT NULL,
      max_slippage_bps INTEGER NOT NULL,
      max_price_impact_bps INTEGER NOT NULL DEFAULT 100,
      allow_overnight INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,               -- ACTIVE | PAUSED
      principal_floor_atomic TEXT,        -- Kamino only
      principal_floor_source TEXT,        -- DEPOSIT_CONFIRMED | USER_CONFIRMED
      safety_buffer_atomic TEXT,
      kamino_vault TEXT,
      kamino_share_mint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      wallet TEXT NOT NULL,
      symbol TEXT NOT NULL,
      mint TEXT NOT NULL,
      corporate_action_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      raw_balance_atomic TEXT NOT NULL,
      multiplier_before TEXT NOT NULL,
      multiplier_after TEXT NOT NULL,
      activation_datetime TEXT NOT NULL,
      snapshot_slot TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (rule_id, corporate_action_id)
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      wallet TEXT NOT NULL,
      kind TEXT NOT NULL,                 -- DIVIDEND | INTEREST
      mode TEXT NOT NULL,                 -- LIVE | REPLAY
      status TEXT NOT NULL,               -- CONFIRMED | FAILED | PARTIAL
      execution_key TEXT NOT NULL,
      signature TEXT,
      slot TEXT,
      inputs_json TEXT NOT NULL,          -- every computation input
      outputs_json TEXT NOT NULL,         -- every computation output
      quote_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_key_confirmed
      ON receipts(execution_key) WHERE status = 'CONFIRMED';

    CREATE TABLE IF NOT EXISTS execution_claims (
      execution_key TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      released_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stranded_funds (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      wallet TEXT NOT NULL,
      mint TEXT NOT NULL,
      raw_atomic TEXT NOT NULL,
      origin TEXT NOT NULL,
      swept INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_intents (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      wallet TEXT NOT NULL,
      kind TEXT NOT NULL,                 -- DIVIDEND | INTEREST
      stage TEXT NOT NULL,                -- WITHDRAW | SWAP | DONE
      execution_key TEXT NOT NULL,
      -- SHA-256 of the MESSAGE bytes of the transaction we prepared. A signed
      -- transaction whose message differs is refused before broadcast.
      message_hash TEXT,
      jupiter_request_id TEXT,
      authorised_raw TEXT,
      source_mint TEXT,
      destination_mint TEXT,
      snapshot_json TEXT,
      withdrawn_raw TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | CONSUMED | ABANDONED
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intents_rule ON execution_intents(rule_id, status);
    CREATE INDEX IF NOT EXISTS idx_rules_wallet ON rules(wallet);
    CREATE INDEX IF NOT EXISTS idx_snapshots_rule ON snapshots(rule_id, processed);
    CREATE INDEX IF NOT EXISTS idx_receipts_rule ON receipts(rule_id, created_at DESC);
  `);
}

/**
 * Additive column migrations.
 *
 * Kept separate from CREATE TABLE so an existing database upgrades in place
 * rather than needing to be rebuilt. Each is tried independently; a duplicate
 * column error means it is already applied.
 */
function addColumns(d) {
  const columns = [
    // Post-settlement verification outcome, distinct from delivery status.
    ['receipts', 'verification TEXT'],
    ['receipts', 'verification_note TEXT'],
    ['receipts', 'preserved INTEGER'],
    ['receipts', 'proofs_json TEXT'],
    ['receipts', 'intent_id TEXT'],
    // Drift baselines: what Overflow last knew the position to be. If the real
    // balance moves outside Overflow, attribution is no longer trustworthy.
    ['rules', 'source_raw_baseline TEXT'],
    ['rules', 'vault_shares_baseline TEXT'],
    ['rules', 'baseline_updated_at TEXT'],
    ['rules', 'pause_reason TEXT'],
  ];
  for (const [table, definition] of columns) {
    try { d.exec(`ALTER TABLE ${table} ADD COLUMN ${definition};`); } catch { /* already present */ }
  }
}

export function nowIso() {
  return new Date().toISOString();
}
