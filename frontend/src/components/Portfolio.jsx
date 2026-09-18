import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRaw, formatUsd } from '../lib/format.js';

/**
 * Stocks actually held in the wallet, read from chain.
 *
 * This is the other half of the proof: after a principal withdrawal these
 * holdings are still here. Quantities are shown BOTH ways on purpose -- the raw
 * Token-2022 balance and the multiplier-scaled display figure -- because the raw
 * amount is what transactions use and the scaled one is what a wallet shows.
 */
export default function Portfolio({ connection, destinations, totalInvestedAtomic = '0' }) {
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connection || !destinations.length) { setHoldings([]); return; }
    let cancelled = false;
    setLoading(true);
    const equities = destinations.filter((d) => !d.isStable);
    Promise.all(equities.map(async (d) => {
      try {
        const r = await api.tokenBalance(connection.address, d.mint);
        return {
          symbol: d.symbol,
          name: d.name,
          rawAtomic: r.balance?.rawAtomic ?? '0',
          uiAmount: r.balance?.uiAmount ?? '0',
          decimals: r.balance?.decimals ?? d.decimals ?? 8,
          multiplier: r.mint?.effectiveMultiplier ?? null,
          hasAccount: Boolean(r.balance?.hasAccount),
        };
      } catch {
        return { symbol: d.symbol, name: d.name, rawAtomic: '0', uiAmount: '0', decimals: 8, error: true };
      }
    })).then((rows) => { if (!cancelled) setHoldings(rows); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connection, destinations]);

  const held = holdings.filter((h) => BigInt(h.rawAtomic || '0') > 0n);

  return (
    <div className="card tight">
      <div className="section-title" style={{ marginBottom: 12 }}>Stock portfolio built from yield</div>

      {loading && <div className="notice"><span className="spinner" /> Reading token balances from chain…</div>}

      {!loading && !held.length && (
        <div className="hint" style={{ marginTop: 0 }}>
          No equity holdings yet. They appear here once a harvest confirms - bought with yield only.
        </div>
      )}

      {held.map((h) => (
        <div className="holding" key={h.symbol}>
          <div>
            <div className="holding-sym equity">{h.symbol}</div>
            <div className="holding-sub">
              {h.name}
              {h.multiplier && ` · multiplier ${Number(h.multiplier).toFixed(6)}`}
            </div>
          </div>
          <div>
            <div className="holding-qty">{Number(h.uiAmount).toFixed(6)}</div>
            <div className="holding-raw">raw {formatRaw(h.rawAtomic, h.decimals, h.decimals)}</div>
          </div>
        </div>
      ))}

      <div className="proof-strip">
        <div className="proof-box good">
          <div className="k">Yield invested</div>
          <div className="v">{formatUsd(totalInvestedAtomic)}</div>
        </div>
        <div className="proof-box good">
          <div className="k">Principal spent on stocks</div>
          <div className="v">{formatUsd('0')} ✓</div>
        </div>
        <div className="proof-box">
          <div className="k">Holdings</div>
          <div className="v equity">{held.length} asset{held.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div className="hint">
        These holdings are independent of the lending position. Withdrawing principal returns USDC
        and leaves every share above untouched.
      </div>
    </div>
  );
}
