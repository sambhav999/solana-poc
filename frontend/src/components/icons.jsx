/**
 * Small hand-drawn icon set, one consistent stroke weight (1.6) throughout so
 * nothing looks borrowed from a mismatched library.
 */
const base = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };

export function IconRules(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h11M4 12h16M4 18h8" />
      <circle cx="19" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPortfolio(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 19V10M11 19V5M18 19v-6" />
      <path d="M3 19h18" />
    </svg>
  );
}

export function IconFirewall(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5l7 2.6v5.1c0 4.4-2.9 7.6-7 9.3-4.1-1.7-7-4.9-7-9.3V6.1z" />
      <path d="M9.3 12.2l1.9 1.9 3.6-3.9" />
    </svg>
  );
}

export function IconReceipts(props) {
  return (
    <svg {...base} {...props}>
      <path d="M6 3h12v18l-2.5-1.6L13 21l-1.5-1.6L10 21l-2.5-1.6L5 21V3z" transform="translate(0.5)" />
      <path d="M9 8h6M9 12h6M9 16h3.5" />
    </svg>
  );
}

export function IconReplay(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 12a8 8 0 1 1 2.6 5.9" />
      <path d="M4 20v-5h5" />
    </svg>
  );
}

export function IconWallet(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h11A2.5 2.5 0 0 1 19 7.5V8H5.5A2.5 2.5 0 0 1 3 5.5" />
      <rect x="3" y="8" width="18" height="11" rx="2.2" />
      <path d="M15.5 13.5h2.2" />
    </svg>
  );
}

export function IconSpark(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}

export function IconVault(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <circle cx="12" cy="12" r="3.3" />
      <path d="M12 8.7v.6M12 14.7v.6M8.7 12h.6M14.7 12h.6" />
    </svg>
  );
}

export function IconArrowRight(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconChevronDown(props) {
  return (
    <svg {...base} {...props}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconPower(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5v7.2" />
      <path d="M7 6.4a7.5 7.5 0 1 0 10 0" />
    </svg>
  );
}

export function IconMenu(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function IconClose(props) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** The brand mark: a vessel that holds a level of liquid and overflows one drop above the rim. */
export function IconLogo(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M5 10.5c0-.9.55-1.7 1.4-2L11.2 7a2 2 0 0 1 1.6 0l4.8 1.5c.85.3 1.4 1.1 1.4 2V17a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"
            fill="currentColor" opacity=".16" />
      <path d="M5 11.2 12 9l7 2.2V17a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 9V4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="3.1" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function IconEmptyDoc(props) {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
      <path d="M10 12h4M10 15.5h4M10 8.5h1.5" />
    </svg>
  );
}

const markGlyph = {
  width: '54%',
  height: '54%',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const MARKS = {
  lock: (
    <>
      <rect x="7" y="11" width="10" height="9" rx="2" />
      <path d="M9.2 11V8.6a2.8 2.8 0 0 1 5.6 0V11" />
      <circle cx="12" cy="15.4" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.4l7 2.5v5.2c0 4.2-2.8 7.3-7 9-4.2-1.7-7-4.8-7-9V5.9z" />
      <path d="M9.2 12.2l1.9 1.9 3.7-4" />
    </>
  ),
  dest: (
    <>
      <path d="M12 3.5l8 14.5H4z" />
      <path d="M12 9.5v5.2M12 16.6h.01" />
    </>
  ),
  wallet: (
    <>
      <rect x="3.5" y="7" width="17" height="12" rx="2.2" />
      <path d="M3.5 9.5H19a1.5 1.5 0 0 0 0-3H7" />
      <circle cx="16.2" cy="13.2" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  dividend: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M9.2 10.4h3.2a1.8 1.8 0 0 1 0 3.6H9.2" />
    </>
  ),
  yield: (
    <>
      <path d="M4 17V11M9.5 17V7M15 17v-4.5M20 17V5" />
    </>
  ),
  receipt: (
    <>
      <path d="M7 3.5h8.2L19.5 8v13.2l-2.4-1.4-2.4 1.4-2.3-1.4-2.4 1.4-2.4-1.4-2.1 1.4z" />
      <path d="M15.2 3.5V8h4.3M9.2 11.2h6M9.2 14.4h6M9.2 17.6h3.4" />
    </>
  ),
  replay: (
    <>
      <path d="M5 12a7 7 0 1 1 2.2 5.1" />
      <path d="M5 19.2V14.4H9.8" />
    </>
  ),
};

const MARK_IMG = {
  lock: '/images/mark-lock.png?v=4',
  shield: '/images/mark-shield.png?v=4',
  dest: '/images/mark-dest.png?v=4',
  wallet: '/images/mark-wallet.png?v=4',
  receipt: '/images/mark-receipt.png?v=4',
  dividend: '/images/mark-dividend.png?v=4',
  yield: '/images/mark-yield.png?v=4',
  replay: '/images/mark-replay.png?v=4',
};

export function Mark({ kind = 'lock', size = 44, className = '', drawn = false }) {
  const src = drawn ? null : MARK_IMG[kind];
  if (src) {
    return (
      <img
        className={`mark-pic ${className}`.trim()}
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span className={`mark mark-${kind} ${className}`.trim()} style={{ width: size, height: size }} aria-hidden="true">
      <svg {...markGlyph}>{MARKS[kind] ?? MARKS.lock}</svg>
    </span>
  );
}
