import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { signTransactionBase64 } from '../lib/wallet.js';
import { formatUsd, explorerUrl, shortAddress } from '../lib/format.js';

/**
 * Deposit and principal withdrawal for a Kamino interest rule.
 *
 * Both are prepare -> sign -> confirm, and the principal floor moves only after
 * a confirmed signature. Nothing here ever claims a guarantee: if the position
 * is impaired, the shortfall is shown before the user signs.
 */
export default function KaminoPanel({ rule, connection, onChanged }) {
  const [amount, setAmount] = useState('');
  const [withdrawPlan, setWithdrawPlan] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    api.pendingFunds(rule.id).then(setPending).catch(() => {});
  }, [rule.id, result]);

  async function signAndSend(prepared, submitFn) {
    const signed = await signTransactionBase64({
      wallet: connection.wallet,
      account: connection.account,
      transactionBase64: prepared.transaction,
    });
    return submitFn({ signedTransaction: signed, context: prepared.context });
  }

  async function handleDeposit() {
    setError(null); setResult(null); setPhase('depositing');
    try {
      const prepared = await api.deposit(rule.id, toAtomic(amount, 6));
      setPhase('signing');
      const out = await signAndSend(prepared, (p) => api.depositSubmit(rule.id, p));
      setResult({ kind: 'DEPOSIT', ...out });
      setAmount('');
      await onChanged();
    } catch (err) {
      setError(err.body?.detail || err.message);
    } finally { setPhase('idle'); }
  }

  async function loadWithdrawPlan() {
    setError(null); setResult(null); setPhase('planning');
    try {
      setWithdrawPlan(await api.withdrawPrincipal(rule.id));
    } catch (err) {
      setError(err.body?.detail || err.message);
      setWithdrawPlan(null);
    } finally { setPhase('idle'); }
  }

  async function handleWithdrawPrincipal() {
    if (!withdrawPlan?.ok) return;
    setError(null); setPhase('signing');
    try {
      const out = await signAndSend(withdrawPlan, (p) => api.withdrawPrincipalSubmit(rule.id, p));
      setResult({ kind: 'PRINCIPAL_WITHDRAW', ...out });
      setWithdrawPlan(null);
      await onChanged();
    } catch (err) {
      setError(err.body?.detail || err.message);
    } finally { setPhase('idle'); }
  }

  const busy = phase !== 'idle';

  return (
    <div className="card tight" style={{ marginTop: 14 }}>
      <div className="section-title" style={{ marginBottom: 12 }}>Principal</div>

      <div className="rule-meta" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
        <M k="Stored principal floor" v={formatUsd(rule.principalFloorAtomic ?? '0')} />
        <M k="Set by" v={rule.principalFloorSource === 'DEPOSIT_CONFIRMED' ? 'confirmed deposit' : 'user confirmation'} />
        {pending && BigInt(pending.totalAtomic || '0') > 0n && (
          <M k="Withdrawn, awaiting swap" v={formatUsd(pending.totalAtomic)} />
        )}
      </div>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="field">
          <label>Deposit USDC</label>
          <input type="number" min="0" step="10" value={amount} disabled={busy}
                 onChange={(e) => setAmount(e.target.value)} placeholder="1000" />
          <div className="hint">The floor rises by the confirmed amount, never by the position value.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button className="btn primary" onClick={handleDeposit} disabled={busy || !amount || !connection}>
            {phase === 'depositing' ? 'Preparing…' : phase === 'signing' ? 'Waiting for wallet…' : 'Deposit'}
          </button>
          <button className="btn danger" onClick={loadWithdrawPlan} disabled={busy || !connection || !rule.principalFloorAtomic}>
            Withdraw principal
          </button>
        </div>
      </div>

      {withdrawPlan?.ok && (
        <div className="card tight" style={{ borderColor: withdrawPlan.plan.impaired ? 'var(--bad)' : 'var(--rule)' }}>
          <div className="eyebrow" style={{ fontWeight: 600 }}>REVIEW PRINCIPAL WITHDRAWAL</div>
          <div className="rule-meta">
            <M k="Principal floor" v={formatUsd(withdrawPlan.plan.requestedAtomic)} />
            <M k="Actually redeemable" v={formatUsd(withdrawPlan.plan.redeemableAtomic)} />
            <M k="Will be returned" v={formatUsd(withdrawPlan.plan.withdrawableAtomic)} />
          </div>
          {withdrawPlan.plan.impaired ? (
            <div className="notice bad">
              The lending position is impaired. You will receive{' '}
              {formatUsd(withdrawPlan.plan.withdrawableAtomic)}, which is{' '}
              {formatUsd(withdrawPlan.plan.shortfallAtomic)} short of your stored principal floor.
              Overflow does not claim principal is guaranteed.
            </div>
          ) : (
            <div className="notice ok">
              Full principal is redeemable. Stocks previously bought from earnings are a separate
              holding and are not touched by this withdrawal.
            </div>
          )}
          <div className="controls">
            <button className="btn danger" onClick={handleWithdrawPrincipal} disabled={busy}>
              {phase === 'signing' ? 'Waiting for wallet…' : 'Sign & withdraw'}
            </button>
            <button className="btn" onClick={() => setWithdrawPlan(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {withdrawPlan && !withdrawPlan.ok && (
        <div className="notice bad">{withdrawPlan.detail ?? withdrawPlan.reason}</div>
      )}
      {error && <div className="notice bad">{error}</div>}

      {result && (
        <div className="receipt">
          <div className="receipt-title">
            {result.kind === 'DEPOSIT' ? 'DEPOSIT CONFIRMED' : 'PRINCIPAL WITHDRAWAL CONFIRMED'}
          </div>
          {result.kind === 'DEPOSIT' ? (
            <>
              <R k="Principal floor before" v={formatUsd(result.floorBefore)} />
              <R k="Principal floor after" v={formatUsd(result.floorAfter)} cls="preserved-yes" />
              <R k="Observed position delta" v={formatUsd(result.observedDeltaAtomic)} />
            </>
          ) : (
            <>
              <R k="Returned to wallet" v={`${formatUsd(result.returnedAtomic)} USDC`} cls="preserved-yes" />
              <R k="Principal floor after" v={formatUsd(result.floorAfter)} />
              {!result.fullyReturnable && (
                <R k="Shortfall" v={formatUsd(result.shortfallAtomic)} cls="" />
              )}
              <R k="Stocks bought from earnings" v="untouched ✓" cls="equity" />
            </>
          )}
          <hr />
          <R k="Solana tx" v={<a href={explorerUrl(result.signature)} target="_blank" rel="noreferrer">{shortAddress(result.signature, 8)}</a>} />
          {result.warning && <div className="notice warn" style={{ marginTop: 10 }}>{result.warning}</div>}
          {result.floorWarning && <div className="notice bad" style={{ marginTop: 10 }}>{result.floorWarning}</div>}
        </div>
      )}
    </div>
  );
}

function M({ k, v }) { return <div><div className="meta-k">{k}</div><div className="meta-v money">{v}</div></div>; }
function R({ k, v, cls = '' }) {
  return <div className="receipt-row"><span className="k">{k}</span><span className={`v ${cls}`}>{v}</span></div>;
}
function toAtomic(value, decimals) {
  const [whole = '0', frac = ''] = String(value || '0').split('.');
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '0').padEnd(decimals, '0'))).toString();
}
