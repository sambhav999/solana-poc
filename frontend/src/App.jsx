import { useCallback, useEffect, useState } from 'react';
import { api, onSessionLost } from './lib/api.js';
import WalletBar from './components/WalletBar.jsx';
import RuleCard from './components/RuleCard.jsx';
import CreateRule from './components/CreateRule.jsx';
import ReplayPanel from './components/ReplayPanel.jsx';
import Receipt from './components/Receipt.jsx';
import Portfolio from './components/Portfolio.jsx';
import IncomePortfolio from './components/IncomePortfolio.jsx';
import FirewallDecisions from './components/FirewallDecisions.jsx';

export default function App() {
  const [connection, setConnection] = useState(null);
  // A connected wallet is only an address. Data loads once it has SIGNED IN.
  const [signedIn, setSignedIn] = useState(false);
  const [portfolio, setPortfolio] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [health, setHealth] = useState(null);
  const [destinations, setDestinations] = useState([]);
  const [rules, setRules] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [tab, setTab] = useState('rules');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(`Backend unreachable: ${e.message}`));
    api.destinations().then((r) => setDestinations(r.destinations || [])).catch(() => {});
  }, []);

  // A rejected or expired session drops back to the sign-in prompt.
  useEffect(() => onSessionLost(() => setSignedIn(false)), []);

  const refresh = useCallback(async () => {
    if (!connection || !signedIn) { setRules([]); setReceipts([]); setPortfolio(null); setDecisions([]); return; }
    setLoading(true);
    try {
      const [r, rec] = await Promise.all([
        api.listRules(),
        api.receipts().catch(() => ({ receipts: [] })),
      ]);
      setRules(r.rules || []);
      setReceipts(rec.receipts || []);
      const [pf, dec] = await Promise.all([
        api.portfolio().catch(() => null),
        api.decisions().catch(() => ({ decisions: [] })),
      ]);
      setPortfolio(pf);
      setDecisions(dec.decisions || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [connection, signedIn]);

  useEffect(() => { refresh(); }, [refresh]);

  // Only CONFIRMED interest harvests count as invested. A quote, a pending
  // withdrawal or a failed swap must never inflate this figure.
  const totalInvestedAtomic = receipts
    .filter((r) => r.kind === 'INTEREST' && r.status === 'CONFIRMED')
    .reduce((sum, r) => sum + BigInt(r.inputs?.harvestableAtomic ?? '0'), 0n)
    .toString();

  async function checkForEvents() {
    setPolling(true);
    try { await api.poll(); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setPolling(false); }
  }

  return (
    <div className="wrap">
      <header className="mast">
        <div>
          <div className="brand">Overflow</div>
          <div className="tag">Keep the source. Program the earnings.</div>
        </div>
        <WalletBar
          connection={connection}
          signedIn={signedIn}
          onConnect={(c) => { setConnection(c); setSignedIn(false); }}
          onSignedIn={() => setSignedIn(true)}
          onDisconnect={() => { setConnection(null); setSignedIn(false); }}
        />
      </header>

      <StatusStrip health={health} />
      {error && <div className="notice bad">{error}</div>}

      <nav className="tabs">
        <button className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>Earnings rules</button>
        <button className={`tab ${tab === 'portfolio' ? 'active' : ''}`} onClick={() => setTab('portfolio')}>Earnings built</button>
        <button className={`tab ${tab === 'firewall' ? 'active' : ''}`} onClick={() => setTab('firewall')}>
          Capital Firewall{decisions.length ? ` (${decisions.length})` : ''}
        </button>
        <button className={`tab ${tab === 'receipts' ? 'active' : ''}`} onClick={() => setTab('receipts')}>Receipts</button>
        <button className={`tab ${tab === 'replay' ? 'active' : ''}`} onClick={() => setTab('replay')}>Replay</button>
      </nav>

      {tab === 'rules' && (
        <>
          <div className="section-head">
            <div className="section-title">Your earnings rules</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {signedIn && (
                <button className="btn small" onClick={checkForEvents} disabled={polling}>
                  {polling ? 'Checking…' : 'Check for events'}
                </button>
              )}
              {signedIn && !creating && (
                <button className="btn primary small" onClick={() => setCreating(true)}>+ Create earnings rule</button>
              )}
            </div>
          </div>

          {!connection && (
            <div className="card empty">
              Connect a Solana wallet to create and run earnings rules.
            </div>
          )}

          {connection && !signedIn && (
            <div className="card empty">
              Sign in to continue. Your wallet will ask you to sign a one-time message — it proves you
              control this address, and it authorises no transaction and moves no funds.
            </div>
          )}

          {creating && signedIn && (
            <CreateRule
              connection={connection}
              destinations={destinations}
              defaultKaminoVault={health?.defaultKaminoVault ?? ''}
              onCreated={() => { setCreating(false); refresh(); }}
              onCancel={() => setCreating(false)}
            />
          )}

          {signedIn && loading && !rules.length && <div className="card empty"><span className="spinner" /> Reading positions and corporate actions…</div>}

          {signedIn && !loading && !rules.length && !creating && (
            <div className="card empty">
              No rules yet. Create one to preserve a source position and program where its earnings go.
            </div>
          )}

          {rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} connection={connection} onChanged={refresh}
                      onDeleted={(id) => setRules((rs) => rs.filter((r) => r.id !== id))}
                      totalInvestedAtomic={totalInvestedAtomic} />
          ))}

          {signedIn && rules.some((r) => r.sourceType === 'KAMINO_USDC') && (
            <Portfolio connection={connection} destinations={destinations}
                       totalInvestedAtomic={totalInvestedAtomic} />
          )}
        </>
      )}

      {tab === 'portfolio' && (
        signedIn
          ? <IncomePortfolio portfolio={portfolio} />
          : <div className="card empty">Sign in with your wallet to see what your earnings have built.</div>
      )}

      {tab === 'firewall' && (
        <>
          <div className="section-head">
            <div className="section-title">Capital Firewall decisions</div>
          </div>
          {signedIn
            ? <FirewallDecisions decisions={decisions} />
            : <div className="card empty">Sign in with your wallet to see firewall decisions.</div>}
        </>
      )}

      {tab === 'receipts' && (
        <>
          <div className="section-head"><div className="section-title">Execution receipts</div></div>
          {!receipts.length ? (
            <div className="card empty">No executions yet. A receipt appears here once a transaction confirms on Solana.</div>
          ) : (
            receipts.map((r) => <Receipt key={r.id} receipt={r} />)
          )}
        </>
      )}

      {tab === 'replay' && (
        <>
          <div className="section-head">
            <div className="section-title">Replay a real corporate action</div>
          </div>
          <ReplayPanel />
        </>
      )}

      <footer className="footer">
        <strong>Overflow preserves a source position and routes only the value it newly generates.</strong>{' '}
        For an xStocks dividend that means isolating exactly the raw Token-2022 quantity the multiplier
        change created; for Kamino it means spending only value above a stored principal floor.
        <br /><br />
        “Preserved” is an accounting and allocation rule, not a capital guarantee. USDC, Kamino, smart
        contracts, liquidity and tokenized-equity issuers all carry risk, and these xStocks mints carry
        Token-2022 transfer-hook, permanent-delegate and pausable extensions. Tokenized equities are not
        available in every jurisdiction; eligibility is your responsibility and is separate from technical
        routing. V1 is non-custodial and every execution is user-signed — Overflow never holds a key and
        never trades unattended. Not investment advice.
      </footer>
    </div>
  );
}

function StatusStrip({ health }) {
  if (!health) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
      <span className="pill">LIVE · {health.network}</span>
      <span className={`pill ${health.rpcConfigured ? '' : 'warn'}`}>
        RPC {health.rpcConfigured ? 'configured' : 'public (rate-limited)'}
      </span>
      <span className={`pill ${health.jupiterKeyConfigured ? '' : 'warn'}`}>
        Jupiter {health.jupiterKeyConfigured ? 'keyed' : 'keyless'}
      </span>
      <span className={`pill ${health.kamino?.available ? '' : 'grey'}`}>
        Kamino {health.kamino?.available ? 'ready' : 'unavailable'}
      </span>
      {health.slot && <span className="pill grey">slot {health.slot}</span>}
    </div>
  );
}
