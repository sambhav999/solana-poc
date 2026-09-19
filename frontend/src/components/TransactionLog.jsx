import { formatDateTime, shortAddress } from '../lib/format.js';

/**
 * Clickable ledger of wallet transactions. Each row opens Solscan.
 */
export default function TransactionLog({ transactions, loading }) {
  if (loading && !transactions?.length) {
    return <div className="card empty"><span className="spinner" /> Reading signatures…</div>;
  }
  if (!transactions?.length) {
    return (
      <div className="card empty">
        <div className="section-title" style={{ marginBottom: 6 }}>No transactions yet</div>
        <p className="page-lead">Confirmed harvests, rule registrations, and other signatures from this wallet appear here. Click a row to open the explorer.</p>
      </div>
    );
  }

  return (
    <div className="tx-log" role="list">
      {transactions.map((tx) => (
        <a
          key={tx.signature}
          className={`tx-row ${tx.status === 'FAILED' || tx.err ? 'is-bad' : ''} ${tx.origin === 'OVERFLOW' ? 'is-overflow' : ''}`}
          href={tx.explorerUrl}
          target="_blank"
          rel="noreferrer"
          role="listitem"
        >
          <div className="tx-row-main">
            <span className="tx-label">{tx.label}</span>
            <span className="tx-sig">{shortAddress(tx.signature, 8)}</span>
          </div>
          <div className="tx-row-meta">
            <span className="tx-status">{tx.status || 'CONFIRMED'}</span>
            <span className="tx-time">{formatDateTime(tx.createdAt)}</span>
            <span className="tx-open">Explorer</span>
          </div>
        </a>
      ))}
    </div>
  );
}
