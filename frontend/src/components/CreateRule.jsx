import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * The rule reads like an email filter. That framing is the product: the user is
 * programming where earnings go, not managing a position.
 */
export default function CreateRule({ connection, destinations, defaultKaminoVault = '', onCreated, onCancel }) {
  const [sourceType, setSourceType] = useState('XSTOCK_DIVIDEND');
  const [sourceSymbol, setSourceSymbol] = useState('MCDx');
  // Provider-qualified ("PRESTOCKS:OPENAI"): symbols are not unique across providers.
  const [destinationKey, setDestinationKey] = useState('XSTOCKS:SPYx');
  const [guardMode, setGuardMode] = useState('NONE');
  const [maxPremiumBps, setMaxPremiumBps] = useState('100');
  const [minPremiumBps, setMinPremiumBps] = useState('-500');
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
      const [destinationProvider, destinationSymbol] = destinationKey.split(':');
      const source = check?.asset;
      await api.createRule({
        sourceType,
        sourceId: isDividend ? sourceSymbol : (kaminoVault || undefined),
        sourceSymbol: isDividend ? sourceSymbol : 'USDC',
        sourceMint: isDividend ? source?.mint : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        sourceDecimals: isDividend ? 8 : 6,
        destinationProvider,
        destinationSymbol,
        marketGuardMode: guardMode,
        maxPremiumBps: guardMode === 'NONE' ? null : Number(maxPremiumBps),
        minPremiumBps: guardMode === 'NONE' || minPremiumBps === '' ? null : Number(minPremiumBps),
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
  const selected = destinations.find((d) => `${d.provider}:${d.symbol}` === destinationKey);
  const isPrivate = selected?.category === 'PRIVATE_MARKET';
  // Only offer firewall modes that can actually evaluate this destination.
  const guardOptions = [
    { value: 'NONE', label: 'Off — execute at any price within slippage' },
    ...(selected?.markPriceUsd ? [{ value: 'TOKEN_PREMIUM', label: `Token vs ${selected.provider} mark` }] : []),
    ...(selected?.category === 'PUBLIC_STOCK' ? [{ value: 'PYTH_PARITY', label: 'Token vs listed stock (Pyth Pro)' }] : []),
  ];
  const guardValid = guardOptions.some((o) => o.value === guardMode);
  const bandValid = guardMode === 'NONE' || (Number.isInteger(Number(maxPremiumBps)) && maxPremiumBps !== ''
    && (minPremiumBps === '' || Number(minPremiumBps) <= Number(maxPremiumBps)));
  const canSubmit = !busy && !sourceBlocked && destinationKey && guardValid && bandValid
    && (isDividend || (principalFloorUsd && kaminoVault));

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
        <select value={destinationKey} onChange={(e) => {
          const next = destinations.find((d) => `${d.provider}:${d.symbol}` === e.target.value);
          setDestinationKey(e.target.value);
          // Default private markets to the firewall; they are where premiums run widest.
          setGuardMode(next?.category === 'PRIVATE_MARKET' && next?.markPriceUsd ? 'TOKEN_PREMIUM' : 'NONE');
        }}>
          {[['PUBLIC_STOCK', 'Public stocks — xStocks'], ['PRIVATE_MARKET', 'Private markets — PreStocks & Tessera'], ['STABLE', 'Stable']].map(([cat, label]) => {
            const group = destinations.filter((d) => d.category === cat);
            if (!group.length) return null;
            return (
              <optgroup key={cat} label={label}>
                {group.map((d) => (
                  <option key={`${d.provider}:${d.symbol}`} value={`${d.provider}:${d.symbol}`} disabled={d.tradable === false}>
                    {d.symbol} — {d.name}{d.category === 'PRIVATE_MARKET' ? ` (${d.provider})` : ''}{d.tradable === false ? ' (no route)' : ''}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>

        <span className="kw">FIREWALL</span>
        <div>
          <select value={guardValid ? guardMode : 'NONE'} onChange={(e) => setGuardMode(e.target.value)}>
            {guardOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {guardMode !== 'NONE' && (
            <div className="grid2" style={{ marginTop: 10 }}>
              <div className="field">
                <label>Block if it costs more than (bps over fair value)</label>
                <input type="number" step="10" value={maxPremiumBps} onChange={(e) => setMaxPremiumBps(e.target.value)} />
              </div>
              <div className="field">
                <label>Block if it costs less than (bps, blank = no floor)</label>
                <input type="number" step="10" value={minPremiumBps} onChange={(e) => setMinPremiumBps(e.target.value)} />
              </div>
            </div>
          )}
          <div className="hint">
            {guardMode === 'NONE'
              ? (isPrivate ? 'Private-market tokens often trade well above their mark. A firewall is strongly recommended.' : 'Earnings route at the executable price, subject to slippage.')
              : 'Judged against the price you would actually pay — the live Jupiter quote. A block leaves your earnings untouched. The floor catches a stale mark or a broken market: a price far below fair value is a warning, not a bargain.'}
          </div>
          {!bandValid && <div className="notice bad">The floor must be at or below the cap.</div>}
        </div>

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
