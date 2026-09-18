import { formatUsd, formatRaw } from '../lib/format.js';
import PremiumGauge from './PremiumGauge.jsx';

/** What executing this rule would do right now. Labelled everywhere as a preview. */
export default function PreviewPanel({ preview, rule, onClose }) {
  if (!preview) return null;
  const fw = preview.firewall;
  const blocked = preview.outcome === 'WOULD_BE_BLOCKED';
  return (
    <div className="card tight" style={{ marginTop: 12, borderStyle: 'dashed' }}>
      <div className="replay-banner" style={{ marginBottom: 10 }}>PREVIEW - NOTHING HAS BEEN PREPARED, SIGNED OR MOVED</div>

      {!preview.wouldExecute && !fw && (
        <div className="notice">{preview.reason}</div>
      )}

      {(preview.harvestableAtomic || preview.math) && (
        <div className="rule-meta" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
          {preview.principalFloorAtomic && <M k="Principal floor" v={formatUsd(preview.principalFloorAtomic)} />}
          {preview.redeemableAtomic && <M k="Position value" v={formatUsd(preview.redeemableAtomic)} />}
          {preview.harvestableAtomic && <M k="Earnings available" v={formatUsd(preview.harvestableAtomic)} />}
          {preview.math && <M k="Dividend-created" v={`${preview.math.display.dividendExposure} ${rule.sourceSymbol}`} />}
          {preview.expectedOutRaw && <M k={`Would receive`} v={`${formatRaw(preview.expectedOutRaw, 9, 6)} ${rule.destinationSymbol}`} />}
        </div>
      )}

      {fw && fw.decision !== 'NOT_REQUIRED' && (
        <div style={{ marginTop: 12 }}>
          <div className={`notice ${blocked ? 'bad' : 'ok'}`}>
            {blocked ? 'Would be BLOCKED by the Capital Firewall. ' : 'Would PASS the Capital Firewall. '}{fw.reason}
          </div>
          <PremiumGauge premiumBps={fw.premiumBps} maxPremiumBps={fw.maxPremiumBps} minPremiumBps={fw.minPremiumBps} decision={fw.decision} />
          {fw.tokenSource && <div className="hint">Priced from: {fw.tokenSource}</div>}
        </div>
      )}
      {preview.route && <div className="hint">Route: {preview.route}</div>}
      <div className="controls"><button className="btn small" onClick={onClose}>Close preview</button></div>
    </div>
  );
}
function M({ k, v }) { return <div><div className="meta-k">{k}</div><div className="meta-v money">{v}</div></div>; }
