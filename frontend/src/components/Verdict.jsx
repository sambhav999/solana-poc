const LABEL = {
  VERIFIED_ON_CHAIN: 'VERIFIED ON CHAIN',
  UNVERIFIED: 'UNVERIFIED',
  FAILED: 'FAILED VERIFICATION',
};

const PROOF_LABEL = {
  exactSourceSpend: 'source spend equals the authorised amount',
  sourceSpendAvailable: 'source delta readable from this transaction',
  destinationIncreased: 'destination token increased in this transaction',
  multiplierReRead: 'live multiplier re-read after settlement',
  exposurePreserved: 'source exposure preserved on observed balances',
  floorStillCovered: 'principal floor still covered',
};

/**
 * A settlement verdict, shown separately from delivery status.
 *
 * "The transaction landed" and "we proved what it did" are different claims, and
 * collapsing them is how a receipt ends up asserting something it never checked.
 */
export default function Verdict({ verification, note, proofs }) {
  if (!verification) return null;
  const entries = Object.entries(proofs || {}).filter(([, v]) => typeof v === 'boolean');

  return (
    <div style={{ marginTop: 12 }}>
      <span className={`verdict verdict-${verification}`}>
        {verification === 'VERIFIED_ON_CHAIN' ? '✓' : verification === 'FAILED' ? '✕' : '!'}
        {LABEL[verification] ?? verification}
      </span>
      {note && <div className="hint" style={{ marginTop: 8 }}>{note}</div>}
      {entries.length > 0 && (
        <div className="proof-list">
          {entries.map(([key, value]) => (
            <div key={key} className={`proof-item ${value ? 'yes' : 'no'}`}>
              <span className="mark">{value ? '✓' : '✕'}</span>
              <span>{PROOF_LABEL[key] ?? key}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
