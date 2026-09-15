import { formatRaw } from '../lib/format.js';

/**
 * The one picture that explains the product: the bar is the user's position,
 * the grey part stays, and only the teal sliver -- the exposure the dividend
 * created -- moves. The teal is deliberately tiny, because it should be.
 */
export default function ExposureBar({ math, decimals = 8, symbol }) {
  if (!math) return null;
  const total = BigInt(math.rawBalanceAtomic);
  const routed = BigInt(math.dividendRawAtomic);
  if (total === 0n) return null;

  const routedPct = Number((routed * 100000n) / total) / 1000;
  const keptPct = 100 - routedPct;
  // Give the routed sliver a visible floor so a 0.5% dividend is still legible.
  const visualRouted = Math.max(routedPct, 1.5);

  return (
    <div>
      <div className="exposure-bar" role="img"
           aria-label={`${keptPct.toFixed(2)}% of the position is preserved, ${routedPct.toFixed(3)}% was created by the dividend and routed out`}>
        <div className="kept" style={{ width: `${100 - visualRouted}%` }} />
        <div className="routed" style={{ width: `${visualRouted}%` }} />
      </div>
      <div className="bar-legend">
        <span><span className="swatch" style={{ background: 'var(--preserved)' }} />
          preserved source · {formatRaw(math.remainingRawAtomic, decimals, 8)} {symbol} raw
        </span>
        <span><span className="swatch" style={{ background: 'var(--flow)' }} />
          dividend-created · {formatRaw(math.dividendRawAtomic, decimals, 8)} ({routedPct.toFixed(3)}%)
        </span>
      </div>
    </div>
  );
}
