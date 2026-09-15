import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * The rule reads like an email filter. That framing is the product: the user is
 * programming where earnings go, not managing a position.
 */
export default function CreateRule({ connection, destinations, defaultKaminoVault = '', onCreated, onCancel }) {
  const [sourceType, setSourceType] = useState('XSTOCK_DIVIDEND');
  const [sourceSymbol, setSourceSymbol] = useState('MCDx');
  const [destinationSymbol, setDestinationSymbol] = useState('SPYx');
  const [minExecutionUsd, setMinExecutionUsd] = useState('5');
  const [maxSlippageBps, setMaxSlippageBps] = useState('50');
  const [allowOvernight, setAllowOvernight] = useState(false);
  const [principalFloorUsd, setPrincipalFloorUsd] = useState('');
  const [kaminoVault, setKaminoVault] = useState(defaultKaminoVault);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const isDividend = sourceType === 'XSTOCK_DIVIDEND';

  // Prefill the vault from server config once it arrives, unless the user typed one.
  useEffect(() => {
    setKaminoVault((current) => (current ? current : defaultKaminoVault));
  }, [defaultKaminoVault]);

  // A source that cannot be routed can never execute. Check before creation.
  useEffect(() => {
    if (!isDividend || !sourceSymbol) { setCheck(null); return; }
    let cancelled = false;
    setCheck({ loading: true });
    // Debounced: checking on every keystroke is what provokes the rate limit
    // that then looks like "no route".
    const timer = setTimeout(() => {
      api.sourceRoutable(sourceSymbol)
        .then((r) => { if (!cancelled) setCheck(r); })
        .catch((e) => { if (!cancelled) setCheck({ ok: true, unverified: true, detail: e.message }); });
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sourceSymbol, isDividend]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const destination = destinations.find((d) => d.symbol === destinationSymbol);
      const source = check?.asset;
      await api.createRule({
        wallet: connection.address,
        sourceType,
        sourceId: isDividend ? sourceSymbol : (kaminoVault || undefined),
        sourceSymbol: isDividend ? sourceSymbol : 'USDC',
        sourceMint: isDividend ? source?.mint : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        sourceDecimals: isDividend ? 8 : 6,
        destinationSymbol,
        destinationMint: destination?.mint,
        minExecutionUsdAtomic: toAtomic(minExecutionUsd, 6),
        maxSlippageBps: Number(maxSlippageBps),
        allowOvernight,
        principalFloorAtomic: isDividend ? null : toAtomic(principalFloorUsd, 6),
        principalFloorSource: isDividend ? null : 'USER_CONFIRMED',
        kaminoVault: isDividend ? null : kaminoVault,
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Only a confirmed "no route" blocks. Unverified is a warning.
  const sourceBlocked = isDividend && check && !check.loading && check.ok === false;
  const canSubmit = !busy && !sourceBlocked && destinationSymbol && (isDividend || (principalFloorUsd && kaminoVault));

  return (
    <form className="card" onSubmit={submit}>
      <div className="section-title" style={{ marginBottom: 16 }}>Create earnings rule</div>

      <div className="rule-sentence">
        <span className="kw">WHEN</span>
        <div className="grid2">
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
            <option value="XSTOCK_DIVIDEND">My xStock pays a dividend</option>
            <option value="KAMINO_USDC">My USDC savings earn interest</option>
          </select>
          {isDividend ? (
            <input type="text" value={sourceSymbol} onChange={(e) => setSourceSymbol(e.target.value.trim())} placeholder="e.g. MCDx" />
          ) : (
            <div>
              <input type="text" value={kaminoVault} onChange={(e) => setKaminoVault(e.target.value.trim())} placeholder="Kamino USDC vault address" />
              {kaminoVault && kaminoVault === defaultKaminoVault && (
                <div className="hint">Using the server's configured Kamino USDC vault.</div>
              )}
            </div>
          )}
        </div>

        <span className="kw">KEEP</span>
        <div>
          {isDividend ? (
            <div className="hint" style={{ marginTop: 0 }}>
              Pre-event equity exposure. Your holding is never reduced below what it was worth before the dividend.
            </div>
          ) : (
            <>
              <input type="number" min="0" step="1" value={principalFloorUsd}
                     onChange={(e) => setPrincipalFloorUsd(e.target.value)} placeholder="Principal floor in USDC" />
              <div className="hint">
                Stored independently and never re-derived from the position value. Confirm the amount you deposited.
              </div>
            </>
          )}
        </div>

        <span className="kw">SEND TO</span>
        <select value={destinationSymbol} onChange={(e) => setDestinationSymbol(e.target.value)}>
          {destinations.map((d) => (
            <option key={d.symbol} value={d.symbol} disabled={!d.tradable}>
              {d.symbol} — {d.name}{!d.tradable ? ' (no route)' : ''}
            </option>
          ))}
        </select>

        <span className="kw">EXECUTE</span>
        <div className="grid2">
          <div className="field">
            <label>When earnings exceed (USD)</label>
            <input type="number" min="0" step="0.5" value={minExecutionUsd} onChange={(e) => setMinExecutionUsd(e.target.value)} />
          </div>
          <div className="field">
            <label>Max slippage (bps)</label>
            <input type="number" min="1" max="500" value={maxSlippageBps} onChange={(e) => setMaxSlippageBps(e.target.value)} />
          </div>
        </div>

        <span className="kw">TIMING</span>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--soft)' }}>
          <input type="checkbox" checked={allowOvernight} onChange={(e) => setAllowOvernight(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Allow execution during overnight/closed sessions. Dividends activate at 00:30 UTC, when the
            book is thinnest; leaving this off defers execution to a deeper market.
          </span>
        </label>
      </div>

      {check?.loading && <div className="notice"><span className="spinner" /> Checking {sourceSymbol} has a live Jupiter route…</div>}
      {sourceBlocked && <div className="notice bad">{check.detail ?? check.reason}</div>}
      {check?.ok && check.unverified && isDividend && (
        <div className="notice warn">
          {check.detail} You can still create the rule; the route is re-checked with fresh data
          before anything is signed.
        </div>
      )}
      {check?.ok && !check.unverified && isDividend && (
        <div className="notice ok">
          {sourceSymbol} is routable (price impact {Number(check.priceImpactPct ?? 0).toFixed(4)}%).
        </div>
      )}
      {error && <div className="notice bad">{error}</div>}

      <div className="controls">
        <button type="submit" className="btn primary" disabled={!canSubmit}>
          {busy ? 'Creating…' : 'Activate rule'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function toAtomic(value, decimals) {
  const [whole = '0', frac = ''] = String(value || '0').split('.');
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '0').padEnd(decimals, '0'))).toString();
}
