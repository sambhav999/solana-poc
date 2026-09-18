import { formatUsd } from '../lib/format.js';

/**
 * "Your Earnings Built This" and "Earnings Retained".
 *
 * Both figures are built from records the user can audit -- confirmed receipts
 * and stored firewall decisions -- never from a running counter. Only earnings
 * the chain PROVED were deployed count as built; the rest are shown separately
 * rather than rolled in.
 */
export default function IncomePortfolio({ portfolio }) {
  if (!portfolio) return null;
  const { built, retained, firewall } = portfolio;

  const pub = BigInt(built.byCategory?.PUBLIC_STOCK?.verifiedAtomic ?? '0');
  const priv = BigInt(built.byCategory?.PRIVATE_MARKET?.verifiedAtomic ?? '0');
  const total = pub + priv;
  const pubPct = total > 0n ? Number((pub * 1000n) / total) / 10 : 50;
  const unverified = BigInt(built.unverifiedAtomic ?? '0');

  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 14 }}>Build a new portfolio from what your assets earn</div>

      <div className="income-hero">
        <div className="income-card built">
          <div className="income-label">Your earnings built this</div>
          <div className="income-value">{formatUsd(built.verifiedAtomic)}</div>
          <div className="income-sub">
            verified on chain across {built.executions} execution{built.executions === 1 ? '' : 's'}
            {unverified > 0n && ` · ${formatUsd(unverified)} more awaiting proof`}
          </div>
          <div className="split" aria-hidden="true">
            <div className="pub" style={{ width: `${total > 0n ? pubPct : 0}%` }} />
            <div className="priv" style={{ width: `${total > 0n ? 100 - pubPct : 0}%` }} />
          </div>
          <div className="split-legend">
            <span><span className="dot" style={{ background: 'var(--equity)' }} />Public stocks {formatUsd(pub.toString())}</span>
            <span><span className="dot" style={{ background: '#7a5bb0' }} />Private markets {formatUsd(priv.toString())}</span>
          </div>
        </div>

        <div className="income-card retained">
          <div className="income-label">Earnings retained</div>
          <div className="income-value">{formatUsd(retained.totalAtomic)}</div>
          <div className="income-sub">
            kept by the Capital Firewall across {retained.blockedCount} price-policy block{retained.blockedCount === 1 ? '' : 's'}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            Every dollar here traces to a stored decision. Blocks caused by missing data or an outage
            are recorded but not counted — only a judgement about price is.
          </div>
          <div className="income-sub" style={{ marginTop: 8 }}>
            {firewall.decisions} decisions · {firewall.passed} passed · {firewall.blocked} blocked
          </div>
        </div>
      </div>

      {built.holdings?.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {built.holdings.map((h) => (
            <div className="holding" key={`${h.category}:${h.symbol}`}>
              <div>
                <div className="holding-sym">{h.symbol}</div>
                <div className="holding-sub">
                  <span className={`chip ${h.category === 'PRIVATE_MARKET' ? 'private' : 'public'}`}>
                    {h.category === 'PRIVATE_MARKET' ? 'PRIVATE MARKET' : 'PUBLIC STOCK'}
                  </span>{' '}
                  {h.executions} execution{h.executions === 1 ? '' : 's'}
                </div>
              </div>
              <div>
                <div className="holding-qty">{formatUsd(h.verifiedAtomic)}</div>
                {BigInt(h.unverifiedAtomic) > 0n && <div className="holding-raw">+{formatUsd(h.unverifiedAtomic)} unverified</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {built.executions === 0 && (
        <div className="hint" style={{ marginTop: 14 }}>
          Nothing built yet. Holdings appear here once an earnings-only execution confirms and is verified on chain.
        </div>
      )}
    </div>
  );
}
