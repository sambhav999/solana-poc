/**
 * Where the price sits against the policy band. The band is the only region a
 * trade may execute in; the marker is what the user would actually pay.
 */
export default function PremiumGauge({ premiumBps, maxPremiumBps, minPremiumBps, decision }) {
  if (premiumBps == null || maxPremiumBps == null) return null;
  const lo = Math.min(minPremiumBps ?? -1000, premiumBps, -200) - 100;
  const hi = Math.max(maxPremiumBps, premiumBps, 200) + 100;
  const pos = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  const bandLeft = minPremiumBps ?? lo;
  return (
    <div>
      <div className="premium-track" role="img"
           aria-label={`Premium ${premiumBps} bps; allowed band ${minPremiumBps ?? 'unbounded'} to ${maxPremiumBps} bps`}>
        <div className="premium-band" style={{ left: pos(bandLeft), width: `calc(${pos(maxPremiumBps)} - ${pos(bandLeft)})` }} />
        <div className={`premium-marker ${decision === 'BLOCK' || decision === 'BLOCKED' ? 'blocked' : ''}`} style={{ left: pos(premiumBps) }} />
      </div>
      <div className="premium-axis">
        <span>{minPremiumBps != null ? `floor ${minPremiumBps} bps` : 'no floor'}</span>
        <span>paying {premiumBps > 0 ? '+' : ''}{premiumBps} bps</span>
        <span>cap +{maxPremiumBps} bps</span>
      </div>
    </div>
  );
}
