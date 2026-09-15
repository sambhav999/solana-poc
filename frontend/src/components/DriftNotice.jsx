import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * External-change notice.
 *
 * Overflow's accounting assumes it is the only thing moving the position. When
 * the balance changes elsewhere — a Kamino deposit, a wallet transfer — the
 * stored baseline no longer describes reality, so the rule pauses rather than
 * computing against a position it no longer understands.
 *
 * Resuming is a deliberate act: the user confirms the position as it now stands.
 */
export default function DriftNotice({ rule, evaluation, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function reconfirm() {
    setBusy(true); setError(null);
    try {
      await api.reconfirmBaseline(rule.id);
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="drift">
      <div className="drift-title">POSITION CHANGED OUTSIDE OVERFLOW — PAUSED</div>
      <div style={{ fontSize: 12 }}>{evaluation.reason}</div>

      {evaluation.drift && (
        <div className="drift-numbers">
          <span>baseline {evaluation.drift.baseline}</span>
          <span>→</span>
          <span>observed {evaluation.drift.observed}</span>
        </div>
      )}

      <div className="hint" style={{ marginTop: 9 }}>
        Nothing will execute until you confirm the position as it stands now. Reconfirming
        re-reads your balance and makes it the new baseline; it does not move any funds.
      </div>

      {error && <div className="notice bad">{error}</div>}

      <div className="controls">
        <button className="btn primary small" onClick={reconfirm} disabled={busy}>
          {busy ? 'Re-reading position…' : 'Reconfirm baseline & resume'}
        </button>
      </div>
    </div>
  );
}
