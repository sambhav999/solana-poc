import { useState } from 'react';
import { api } from '../lib/api.js';
import { formatUsd, formatDateTime, formatRelative } from '../lib/format.js';
import Guards from './Guards.jsx';
import ReadyPanel from './ReadyPanel.jsx';
import KaminoPanel from './KaminoPanel.jsx';
import PrincipalFlow from './PrincipalFlow.jsx';
import DriftNotice from './DriftNotice.jsx';
import PreviewPanel from './PreviewPanel.jsx';
import Receipt from './Receipt.jsx';

export default function RuleCard({ rule, connection, onChanged, onDeleted, totalInvestedAtomic = '0' }) {
  const [busy, setBusy] = useState(false);
  const [lastReceipt, setLastReceipt] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  async function runPreview() {
    setPreviewing(true); setPreviewError(null);
    try { setPreview(await api.preview(rule.id)); }
    catch (err) { setPreviewError(err.message); }
    finally { setPreviewing(false); }
  }
  const evaluation = rule.evaluation || { status: 'BLOCKED', reason: 'not evaluated', guards: {} };
  const status = rule.status === 'PAUSED' ? 'PAUSED' : evaluation.status;

  async function toggle() {
    setBusy(true);
    try {
      await api.updateRule(rule.id, { status: rule.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' });
      await onChanged();
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteRule(rule.id);
      // Remove it the moment the server confirms, rather than leaving a dead card
      // on screen while every other rule is re-evaluated against the RPC.
      onDeleted?.(rule.id);
      onChanged();
    } finally { setBusy(false); }
  }

  const isDividend = rule.sourceType === 'XSTOCK_DIVIDEND';

  return (
    <div className="rule-card">
      <div className="rule-head">
        <div>
          <div className="rule-flow">
            <span>{rule.sourceSymbol ?? rule.sourceId}</span>
            <span className="arrow">— {isDividend ? 'Dividend' : 'Interest'} →</span>
            <span className="equity">{rule.destinationSymbol}</span>
            <span className={`chip ${rule.destinationCategory === 'PRIVATE_MARKET' ? 'private' : 'public'}`}>
              {rule.destinationCategory === 'PRIVATE_MARKET' ? `PRIVATE · ${rule.destinationProvider}` : 'PUBLIC'}
            </span>
          </div>
          <div className="eyebrow" style={{ marginTop: 4 }}>
            {isDividend
              ? 'Keeps pre-event equity exposure. Routes only dividend-created exposure.'
              : 'Keeps the principal floor. Routes only value above it.'}
          </div>
        </div>
        <span className={`status-badge status-${status}`}>{status}</span>
      </div>

      <div className="rule-meta">
        <Meta k="Minimum execution" v={formatUsd(rule.minExecutionUsdAtomic)} />
        <Meta k="Max slippage" v={`${rule.maxSlippageBps} bps`} />
        <Meta k="Capital Firewall" v={rule.marketGuardMode === 'NONE' || !rule.marketGuardMode
          ? 'off'
          : `${rule.marketGuardMode === 'PYTH_PARITY' ? 'vs listed stock' : 'vs mark'} · ${rule.minPremiumBps ?? '—'} to +${rule.maxPremiumBps} bps`} />
        {isDividend ? (
          <Meta k="Watching since" v={formatDateTime(rule.createdAt)} />
        ) : (
          <Meta k="Principal floor" v={rule.principalFloorAtomic ? formatUsd(rule.principalFloorAtomic) : 'not set'} />
        )}
        {rule.openSnapshot && (
          <Meta k="Event activation" v={`${formatDateTime(rule.openSnapshot.activationDateTime)} (${formatRelative(rule.openSnapshot.activationDateTime)})`} />
        )}
      </div>

      {!isDividend && rule.principalFloorAtomic && (
        <PrincipalFlow rule={rule} evaluation={evaluation} totalInvestedAtomic={totalInvestedAtomic} />
      )}

      {evaluation.needsBaselineReconfirm ? (
        <DriftNotice rule={rule} evaluation={evaluation} onChanged={onChanged} />
      ) : (
        <div className={`notice ${noticeClass(status)}`}>{evaluation.reason}</div>
      )}
      <Guards guards={evaluation.guards} />

      {evaluation.multiplierCrossCheck?.checked && (
        <div className="hint" style={{ marginTop: 8 }}>
          On-chain multiplier {evaluation.multiplierCrossCheck.onchain}
          {evaluation.multiplierCrossCheck.matches ? ' matches the API value ✓' : ' DISAGREES with the API value'}
        </div>
      )}

      {status === 'READY' && connection && (
        <ReadyPanel
          rule={rule}
          evaluation={evaluation}
          connection={connection}
          onExecuted={async (result) => { setLastReceipt(result.receipt); await onChanged(); }}
        />
      )}

      {!isDividend && connection && (
        <KaminoPanel rule={rule} connection={connection} onChanged={onChanged} />
      )}

      {lastReceipt && <Receipt receipt={lastReceipt} />}

      {previewError && <div className="notice bad">{previewError}</div>}
      <PreviewPanel preview={preview} rule={rule} onClose={() => setPreview(null)} />

      <div className="controls">
        <button className="btn small" onClick={runPreview} disabled={previewing}>
          {previewing ? 'Previewing…' : 'Preview'}
        </button>
        <button className="btn small" onClick={toggle} disabled={busy}>
          {rule.status === 'ACTIVE' ? 'Pause' : 'Resume'}
        </button>
        <button className="btn small danger" onClick={remove} disabled={busy}>Delete</button>
      </div>
    </div>
  );
}

function noticeClass(status) {
  if (status === 'READY') return 'ok';
  if (status === 'BLOCKED') return 'bad';
  if (status === 'NEEDS_REVIEW') return 'warn';
  return '';
}

function Meta({ k, v }) {
  return (
    <div>
      <div className="meta-k">{k}</div>
      <div className="meta-v money">{v}</div>
    </div>
  );
}
