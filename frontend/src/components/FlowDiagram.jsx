import { useEffect, useState } from 'react';
import { IconVault, IconFirewall, IconWallet } from './icons.jsx';

const ARC = 'M52,96 C130,34 270,34 348,96';

/**
 * The hero illustration: the same picture the product itself relies on, drawn
 * once at the top of the page. The source-to-destination line never breaks --
 * only the small particles travelling the arc represent the earnings that
 * move, gated by the Capital Firewall checkpoint sitting on the path.
 */
export default function FlowDiagram() {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(mq.matches);
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return (
    <div className="flow-diagram">
      <svg viewBox="0 0 400 130" width="100%" role="img" aria-label="Source position connects through the Capital Firewall to your chosen destination; only newly generated earnings travel that path.">
        <line x1="52" y1="96" x2="348" y2="96" stroke="var(--preserved)" strokeWidth="3" strokeOpacity=".35" strokeLinecap="round" />
        <path d={ARC} fill="none" stroke="var(--flow)" strokeWidth="1.6" strokeDasharray="1 7" strokeLinecap="round" opacity=".8" />

        {!reduceMotion && [0, -1.4, -2.8].map((delay) => (
          <circle key={delay} r="3.4" fill="var(--flow)">
            <animateMotion dur="4.2s" begin={`${delay}s`} repeatCount="indefinite" path={ARC} />
          </circle>
        ))}

        <circle cx="52" cy="96" r="26" fill="var(--panel-soft)" stroke="var(--rule)" />
        <circle cx="200" cy="53" r="16" fill="var(--panel-soft)" stroke="var(--rule)" />
        <circle cx="348" cy="96" r="26" fill="var(--panel-soft)" stroke="var(--rule)" />

        <IconVault x="41" y="85" width="22" height="22" style={{ color: 'var(--preserved)' }} strokeWidth="1.5" />
        <IconFirewall x="191" y="44" width="18" height="18" style={{ color: 'var(--primary-strong)' }} strokeWidth="1.6" />
        <IconWallet x="337" y="85" width="22" height="22" style={{ color: 'var(--flow)' }} strokeWidth="1.5" />
      </svg>
      <div className="flow-diagram-labels">
        <div>
          <b>Source</b>
          <span>xStocks · Kamino</span>
        </div>
        <div>
          <b>Capital Firewall</b>
          <span>price-policy gate</span>
        </div>
        <div>
          <b>Destination</b>
          <span>your choice</span>
        </div>
      </div>
    </div>
  );
}
