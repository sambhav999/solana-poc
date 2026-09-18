import { getDb, nowIso } from './index.js';

export function saveNonce({ wallet, nonce, message, expiresAt }) {
  getDb().prepare(
    'INSERT INTO auth_nonces (nonce, wallet, message, expires_at, created_at) VALUES (?,?,?,?,?)'
  ).run(nonce, wallet, message, expiresAt, nowIso());
}

/**
 * Atomically consume a nonce. The UPDATE succeeds only for an unused, unexpired
 * nonce belonging to this wallet, so a replayed signature finds nothing to use.
 */
export function consumeNonce({ wallet, nonce }) {
  const db = getDb();
  const row = db.prepare(
    'SELECT message FROM auth_nonces WHERE nonce = ? AND wallet = ? AND used_at IS NULL AND expires_at > ?'
  ).get(nonce, wallet, nowIso());
  if (!row) return null;
  const changed = db.prepare(
    'UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL'
  ).run(nowIso(), nonce).changes;
  return changed === 1 ? row.message : null;
}

export function purgeExpiredNonces() {
  return getDb().prepare('DELETE FROM auth_nonces WHERE expires_at < ?').run(nowIso()).changes;
}
