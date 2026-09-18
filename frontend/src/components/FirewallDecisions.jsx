import { formatUsd, formatDateTime } from '../lib/format.js';
import PremiumGauge from './PremiumGauge.jsx';
import { Mark } from './icons.jsx';

/** Every Capital Firewall decision, with the evidence it was made on. */
export default function FirewallDecisions({ decisions }) {
  if (!decisions?.length) {
    return (
      <div className="card empty-state">
        <Mark kind="shield" size={64} />
        <div className="empty-copy">
          <div className="empty-title">No firewall decisions yet</div>
          <div className="empty-sub">One is recorded, with its evidence, each time a rule with a market-price policy reaches execution.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      {decisions.map((d) => {
        const e = d.evidence ?? {};
        return (
          <div key={d.id} style={{ borderTop: '1px solid var(--rule)', paddingTop: 12, marginTop: 12 }}>
            <div className="decision" style={{ borderTop: 'none', padding: 0 }}>
              <span className={`decision-badge ${d.outcome}`}>{d.outcome}</span>
              <div className="decision-main">
                <div className="decision-title">
                  {d.destinationSymbol}{' '}
                  <span className={`chip ${d.destinationCategory === 'PRIVATE_MARKET' ? 'private' : 'public'}`}>{d.destinationProvider}</span>
                </div>
                <div className="decision-reason">{e.reason}</div>
              </div>
              <div className="decision-amt">
                {formatUsd(d.earningsUsdAtomic)}
                <div className="holding-raw">{formatDateTime(d.updatedAt)}</div>
              </div>
            </div>
            <PremiumGauge premiumBps={e.premiumBps} maxPremiumBps={e.maxPremiumBps} minPremiumBps={e.minPremiumBps} decision={d.outcome} />
            <div className="hint" style={{ marginTop: 6 }}>
              {e.tokenPriceUsd && `paying $${e.tokenPriceUsd} (${e.tokenSource})`}
              {e.referencePriceUsd && ` · fair value $${e.referencePriceUsd} (${e.referenceSource})`}
              {e.countsAsRetained === false && d.outcome === 'BLOCKED' && ' · not counted as retained (data unavailable, not a price judgement)'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
