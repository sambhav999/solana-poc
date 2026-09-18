import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRaw, formatDateTime } from '../lib/format.js';
import ExposureBar from './ExposureBar.jsx';

/**
 * Replay Mode.
 *
 * Runs the real extraction maths over a REAL historical corporate action with a
 * stated hypothetical balance. It is labelled everywhere, produces no signature,
 * and never claims a swap occurred.
 *
 * It is also where the safety control is most visible: replaying a Split shows
 * what a naive "the multiplier went up" implementation would have sold.
 */
export default function ReplayPanel() {
  const [symbol, setSymbol] = useState('MRKx');
  const [query, setQuery] = useState('MRKx');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState('10');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setResult(null);
    api.replayEvents(query)
      .then((r) => { if (!cancelled) setEvents(r.events || []); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  async function run(event) {
    setError(null);
    try {
      setResult(await api.replay(query, {
        corporateActionId: event.corporateActionId,
        rawBalanceAtomic: toRaw(balance, 8),
        tokenDecimals: 8,
      }));
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="card">
      <div className="replay-banner">Replay mode. Historical corporate action. No transaction is executed.</div>

      <div className="grid2">
        <div className="field">
          <label>xStock symbol</label>
          <form onSubmit={(e) => { e.preventDefault(); setQuery(symbol); }}>
            <input type="text" value={symbol} onChange={(e) => setSymbol(e.target.value.trim())} placeholder="MRKx, KLACx, NFLXx…" />
          </form>
          <div className="hint">Try MRKx for dividends, or KLACx / NFLXx for a 10:1 split.</div>
        </div>
        <div className="field">
          <label>Hypothetical holding (display units)</label>
          <input type="number" min="0" step="1" value={balance} onChange={(e) => setBalance(e.target.value)} />
          <div className="hint">Stated as hypothetical. No wallet held this position.</div>
        </div>
      </div>

      {loading && <div className="notice"><span className="spinner" /> Loading real multiplier history…</div>}
      {error && <div className="notice bad">{error}</div>}

      {!loading && !events.length && !error && (
        <div className="notice">No recorded corporate actions for {query}.</div>
      )}

      {events.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {events.map((e) => (
            <div className="event-row" key={e.corporateActionId}>
              <span className="money">{String(e.activationDateTime).slice(0, 10)}</span>
              <span className={e.supported ? 'preserved-yes' : ''} style={{ fontWeight: 600 }}>{e.reason}</span>
              <span className="money" style={{ fontSize: 11, color: 'var(--soft)' }}>
                {e.multiplierBefore} → {e.multiplierAfter}
              </span>
              <button className="btn small" onClick={() => run(e)}>Replay</button>
            </div>
          ))}
        </div>
      )}

      {result && (result.ok ? (
        <div className="card tight" style={{ borderColor: 'var(--flow)' }}>
          <div className="eyebrow" style={{ color: 'var(--flow)', fontWeight: 600 }}>
            {result.event.reason.toUpperCase()} · {formatDateTime(result.event.activationDateTime)}
          </div>
          <ExposureBar math={result.math} decimals={8} symbol={query} />
          <div className="rule-meta">
            <M k="Pre-event exposure" v={result.math.display.preEventExposure} />
            <M k="Post-event exposure" v={result.math.display.postEventExposure} />
            <M k="Dividend created" v={`${result.math.display.dividendExposure} (${Number(result.math.display.dividendYieldPct).toFixed(3)}%)`} />
            <M k="Remaining exposure" v={`${result.math.display.remainingExposure} ✓`} />
          </div>
          <div className="receipt" style={{ marginTop: 12 }}>
            <div className="receipt-title">THE FORMULA, ON REAL DATA</div>
            <div>dividendRaw = floor(R × (m1 − m0) / m1)</div>
            <div style={{ marginTop: 6, color: 'var(--soft)' }}>
              = floor({result.math.rawBalanceAtomic} × ({result.math.multiplierAfter} − {result.math.multiplierBefore}) / {result.math.multiplierAfter})
            </div>
            <div style={{ marginTop: 6 }}>= {result.math.dividendRawAtomic} raw units</div>
            <hr />
            <div className="preserved-yes">
              remaining exposure ({result.math.remainingExposure}) ≥ pre-event exposure ({result.math.preEventExposure}) ✓
            </div>
          </div>
          <div className="notice">{result.disclaimer}</div>
        </div>
      ) : (
        <div className="card tight" style={{ borderColor: 'var(--bad)' }}>
          <div className="eyebrow" style={{ color: 'var(--bad)', fontWeight: 600 }}>
            REFUSED · {result.classification?.eventType}
          </div>
          <div className="notice bad">{result.classification?.detail ?? result.reason}</div>
          {result.wouldHaveExtracted?.dividendRawAtomic && (
            <>
              <div className="receipt">
                <div className="receipt-title">WHAT A NAIVE IMPLEMENTATION WOULD HAVE DONE</div>
                <div className="receipt-row">
                  <span className="k">Would have routed</span>
                  <span className="v" style={{ color: 'var(--bad)' }}>
                    {formatRaw(result.wouldHaveExtracted.dividendRawAtomic, 8, 8)} raw units
                    {' '}({(Number(result.wouldHaveExtracted.fractionBps) / 100).toFixed(2)}% of the position)
                  </span>
                </div>
              </div>
              <div className="notice warn">{result.note}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function M({ k, v }) {
  return <div><div className="meta-k">{k}</div><div className="meta-v money">{v}</div></div>;
}

function toRaw(value, decimals) {
  const [whole = '0', frac = ''] = String(value || '0').split('.');
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '0').padEnd(decimals, '0'))).toString();
}
