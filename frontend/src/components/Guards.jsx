const LABELS = {
  eventType: 'event type',
  activationSafe: 'activation window',
  sourcePreserved: 'source preserved',
  threshold: 'threshold',
  idempotent: 'not yet executed',
  balanceUnchanged: 'balance unchanged',
  quoteAvailable: 'route',
  slippageSafe: 'slippage',
  positionRead: 'position read',
};

/** Every guard is shown, passing or failing. Hiding the failures hides the product. */
export default function Guards({ guards }) {
  const entries = Object.entries(guards || {});
  if (!entries.length) return null;
  return (
    <div className="guards">
      {entries.map(([key, value]) => (
        <span key={key} className={`guard ${value ? 'pass' : 'fail'}`}>
          {value ? '✓' : '✕'} {LABELS[key] ?? key}
        </span>
      ))}
    </div>
  );
}
