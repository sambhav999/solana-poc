import { useEffect, useMemo, useState } from 'react';

const W = 720;
const H = 188;
const PAD = { l: 10, r: 12, t: 14, b: 18 };

const VARIANTS = {
  stream: {
    title: 'Yield above the floor',
    legend: [
      { className: 'floor', label: 'Floor' },
      { className: 'flow', label: 'Yield' },
      { className: 'gold', label: 'Harvest' },
    ],
  },
  split: {
    title: 'Built vs retained',
    legend: [
      { className: 'muted', label: 'Built' },
      { className: 'flow', label: 'Retained' },
      { className: 'gold', label: 'Kept' },
    ],
  },
  band: {
    title: 'Quote vs policy band',
    legend: [
      { className: 'muted', label: 'Band' },
      { className: 'flow', label: 'Quote' },
      { className: 'gold', label: 'Edge' },
    ],
  },
  steps: {
    title: 'Confirmations on Solana',
    legend: [
      { className: 'flow', label: 'Confirmed' },
      { className: 'gold', label: 'Final' },
    ],
  },
  replay: {
    title: 'Multiplier history',
    legend: [
      { className: 'floor', label: 'Base' },
      { className: 'flow', label: 'Multiplier' },
      { className: 'gold', label: 'Gain' },
    ],
  },
};

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function seed(variant) {
  const n = 48;
  const pts = [];
  if (variant === 'stream') {
    let yld = 6;
    for (let i = 0; i < n; i++) {
      if (yld > 22 && i % 12 === 0) yld = 5;
      else yld = clamp(yld + 0.28 + Math.sin(i / 4.2) * 0.45, 4, 24);
      pts.push({ a: 58, b: 58 + yld });
    }
  } else if (variant === 'split') {
    let built = 8;
    let retained = 3;
    for (let i = 0; i < n; i++) {
      if (i % 9 === 0) built += 3.6;
      if (i % 14 === 0) retained += 1.8;
      pts.push({ a: built, b: retained });
    }
  } else if (variant === 'band') {
    for (let i = 0; i < n; i++) {
      const quote = 36 + Math.sin(i / 3.1) * 62 + Math.sin(i / 1.1) * 12;
      pts.push({ a: 150, b: -40, c: quote });
    }
  } else if (variant === 'steps') {
    let conf = 0;
    for (let i = 0; i < n; i++) {
      if (i > 8 && i % 7 === 0) conf += 1;
      pts.push({ a: conf, b: conf });
    }
  } else {
    let m = 1;
    for (let i = 0; i < n; i++) {
      if (i === 20) m = 1.028;
      if (i === 34) m = 1.051;
      pts.push({ a: m, b: 1 });
    }
  }
  return pts;
}

function step(variant, pts) {
  const last = pts[pts.length - 1];
  let next;
  if (variant === 'stream') {
    const harvest = last.b - last.a > 20 && Math.random() < 0.1;
    const yld = harvest ? 5 + Math.random() * 1.4 : clamp((last.b - last.a) + 0.22 + Math.sin(Date.now() / 900) * 0.22, 4, 24);
    next = { a: 58, b: 58 + yld };
  } else if (variant === 'split') {
    next = {
      a: last.a + (Math.random() < 0.07 ? 2.8 : 0.04),
      b: last.b + (Math.random() < 0.05 ? 1.5 : 0.02),
    };
  } else if (variant === 'band') {
    const t = Date.now() / 780;
    next = { a: 150, b: -40, c: 34 + Math.sin(t) * 64 + Math.sin(t * 2.1) * 12 };
  } else if (variant === 'steps') {
    next = { a: last.a + (Math.random() < 0.08 ? 1 : 0), b: last.a };
  } else {
    next = { a: last.a + (Math.random() < 0.03 ? 0.006 : 0), b: 1 };
  }
  return pts.slice(1).concat(next);
}

function toPts(values, min, max) {
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const span = Math.max(0.001, max - min);
  return values.map((v, i) => ({
    x: PAD.l + (i / Math.max(1, values.length - 1)) * innerW,
    y: PAD.t + innerH - ((v - min) / span) * innerH,
  }));
}

function smoothLine(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function areaBelow(pts) {
  const line = smoothLine(pts);
  const last = pts[pts.length - 1];
  const first = pts[0];
  const base = PAD.t + (H - PAD.t - PAD.b);
  return `${line} L${last.x.toFixed(1)},${base} L${first.x.toFixed(1)},${base} Z`;
}

function areaBetween(topPts, botPts) {
  const top = smoothLine(topPts);
  const bot = botPts.slice().reverse();
  let d = `${top} L${bot[0].x.toFixed(1)},${bot[0].y.toFixed(1)}`;
  for (let i = 1; i < bot.length; i++) d += ` L${bot[i].x.toFixed(1)},${bot[i].y.toFixed(1)}`;
  return `${d} Z`;
}

export default function RunningChart({ variant = 'stream' }) {
  const meta = VARIANTS[variant] ?? VARIANTS.stream;
  const [pts, setPts] = useState(() => seed(variant));

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPts(seed(variant));
    if (mq.matches) return undefined;
    const id = window.setInterval(() => setPts((p) => step(variant, p)), 640);
    return () => window.clearInterval(id);
  }, [variant]);

  const chart = useMemo(() => {
    if (variant === 'band') {
      const quotes = pts.map((p) => p.c);
      const min = -80;
      const max = 200;
      const q = toPts(quotes, min, max);
      const cap = toPts(pts.map((p) => p.a), min, max);
      const fl = toPts(pts.map((p) => p.b), min, max);
      return {
        paths: [
          { d: areaBetween(cap, fl), className: 'rc-band-fill', fill: 'url(#rcBand)' },
          { d: smoothLine(cap), className: 'rc-band-cap', fill: 'none' },
          { d: smoothLine(fl), className: 'rc-band-floor', fill: 'none' },
          { d: smoothLine(q), className: 'rc-line flow', fill: 'none', stroke: `url(#rcStroke-${variant})`, filter: 'url(#rcGlow)' },
        ],
        last: quotes[quotes.length - 1],
        tip: q[q.length - 1],
      };
    }
    if (variant === 'replay') {
      const min = 0.98;
      const max = 1.08;
      const a = toPts(pts.map((p) => p.a), min, max);
      const b = toPts(pts.map((p) => p.b), min, max);
      return {
        paths: [
          { d: smoothLine(b), className: 'rc-floor', fill: 'none' },
          { d: areaBetween(a, b), className: 'rc-area', fill: `url(#rcFill-${variant})` },
          { d: smoothLine(a), className: 'rc-line flow', fill: 'none', stroke: `url(#rcStroke-${variant})`, filter: 'url(#rcGlow)' },
        ],
        last: pts[pts.length - 1].a,
        tip: a[a.length - 1],
      };
    }
    const aVals = pts.map((p) => p.a);
    const bVals = pts.map((p) => p.b);
    const min = variant === 'stream' ? 48 : 0;
    const max = Math.max(variant === 'stream' ? 90 : 40, ...aVals, ...bVals) * 1.04;
    const a = toPts(aVals, min, max);
    const b = toPts(bVals, min, max);
    const band = variant === 'stream' ? areaBetween(b, a) : areaBelow(b);
    return {
      paths: [
        { d: band, className: 'rc-area', fill: `url(#rcFill-${variant})` },
        { d: smoothLine(a), className: variant === 'stream' ? 'rc-floor' : 'rc-line muted', fill: 'none' },
        { d: smoothLine(b), className: 'rc-line flow', fill: 'none', stroke: `url(#rcStroke-${variant})`, filter: 'url(#rcGlow)' },
      ],
      last: variant === 'stream' ? bVals[bVals.length - 1] - aVals[aVals.length - 1] : bVals[bVals.length - 1],
      tip: b[b.length - 1],
    };
  }, [pts, variant]);

  const last = Number(chart.last);
  const readout = variant === 'replay'
    ? last.toFixed(3)
    : variant === 'band'
      ? `${last > 0 ? '+' : ''}${last.toFixed(0)} bps`
      : variant === 'steps'
        ? `${last.toFixed(0)}`
        : last.toFixed(1);

  return (
    <div className="rc">
      <div className="rc-head">
        <span className="rc-live"><span className="rc-pulse" /> Illustrative</span>
        <b>{meta.title}</b>
        <span className="rc-legend" aria-hidden="true">
          {meta.legend.map((item) => (
            <i key={item.label} className={item.className}>{item.label}</i>
          ))}
        </span>
        <span className="rc-readout">{readout}</span>
      </div>
      <svg className="rc-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={meta.title}>
        <defs>
          <linearGradient id={`rcFill-${variant}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7ab8ff" stopOpacity=".55" />
            <stop offset=".42" stopColor="#6d4aff" stopOpacity=".28" />
            <stop offset="1" stopColor="#f5c518" stopOpacity=".04" />
          </linearGradient>
          <linearGradient id={`rcStroke-${variant}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#6d4aff" />
            <stop offset=".48" stopColor="#7ab8ff" />
            <stop offset="1" stopColor="#f5c518" />
          </linearGradient>
          <linearGradient id="rcBand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6d4aff" stopOpacity=".32" />
            <stop offset=".55" stopColor="#7ab8ff" stopOpacity=".14" />
            <stop offset="1" stopColor="#f5c518" stopOpacity=".06" />
          </linearGradient>
          <filter id="rcGlow" x="-20%" y="-40%" width="140%" height="180%">
            <feGaussianBlur stdDeviation="2.6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {[0.33, 0.66].map((g) => (
          <line key={g} className="rc-grid" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + (H - PAD.t - PAD.b) * g} y2={PAD.t + (H - PAD.t - PAD.b) * g} />
        ))}
        {chart.paths.map((p) => (
          <path
            key={p.className}
            d={p.d}
            className={p.className}
            fill={p.fill}
            stroke={p.stroke}
            filter={p.filter}
          />
        ))}
        {chart.tip && (
          <circle className="rc-tip" cx={chart.tip.x} cy={chart.tip.y} r="4.8" />
        )}
      </svg>
    </div>
  );
}
