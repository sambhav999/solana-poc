import { useState } from 'react';
import { api } from '../lib/api.js';
import { signTransactionBase64 } from '../lib/wallet.js';
import { formatRaw, formatUsd, pctFromDecimalString } from '../lib/format.js';
import ExposureBar from './ExposureBar.jsx';
import PremiumGauge from './PremiumGauge.jsx';

/**
 * Review and execute. Nothing is signed until the user has seen exactly what
 * moves, what stays, and what it costs.
 */
export default function ReadyPanel({ rule, evaluation, connection, onExecuted }) {
  const [prepared, setPrepared] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | preparing | review | signing | submitting | done
  const [error, setError] = useState(null);
  const [withdrawSignature, setWithdrawSignature] = useState(null);
  const [blocked, setBlocked] = useState(null); // Capital Firewall evidence

  const isDividend = rule.sourceType === 'XSTOCK_DIVIDEND';

  async function handlePrepare() {
    setPhase('preparing'); setError(null); setBlocked(null);
    try {
      const result = await api.prepare(rule.id);
      setPrepared(result);
      setPhase('review');
    } catch (err) {
      // A firewall block is the product working, not a failure: show the evidence.
      if (err.body?.reason === 'FIREWALL_BLOCKED') {
        setBlocked({ ...err.body.firewall, detail: err.body.detail });
        onExecuted?.({ blocked: true });
      } else {
        setError(err.body?.detail || err.message);
      }
      setPhase('idle');
    }
  }

  /**
   * An interest harvest is two signatures: the Kamino withdrawal, then the swap.
   * The withdrawn USDC is recorded between them, so a failure after step one
   * leaves funds accounted for rather than lost, and the retry sweeps them.
   */
  async function handleExecute() {
    if (!prepared?.transaction) return;
    setPhase('signing'); setError(null);
    try {
      const signed = await signTransactionBase64({
        wallet: connection.wallet,
        account: connection.account,
        transactionBase64: prepared.transaction,
      });
      setPhase('submitting');

      if (prepared.stage === 'WITHDRAW') {
        const out = await api.harvestWithdrawSubmit(rule.id, {
          signedTransaction: signed,
          context: prepared.context,
        });
        setWithdrawSignature(out.signature);
        if (out.floorWarning) setError(out.floorWarning);
        // Step one is confirmed; re-prepare to get the swap.
        setPhase('preparing');
        const next = await api.prepare(rule.id);
        setPrepared(next);
        setPhase('review');
        return;
      }

      const context = buildContext(rule, prepared, evaluation);
      const result = await api.submit(rule.id, {
        signedTransaction: signed,
        requestId: prepared.requestId,
        executionKey: prepared.executionKey,
        // The server checks the signed message against the intent it recorded.
        intentId: prepared.intentId,
        context: { ...context, sweptEntries: prepared.evaluation?.sweptEntries ?? [] },
      });
      setPhase('done');
      onExecuted?.(result);
    } catch (err) {
      setError(err.body?.detail || err.message);
      setPhase('review');
    }
  }

  const quote = prepared?.quote ?? evaluation.quote;
  const math = evaluation.math;

  return (
    <div className="card tight" style={{ marginTop: 14, borderColor: 'var(--flow)' }}>
      <div className="eyebrow" style={{ color: 'var(--flow)', fontWeight: 600 }}>EARNINGS READY</div>

      {isDividend && math && (
        <>
          <div style={{ marginTop: 12 }}>
            <ExposureBar math={math} decimals={rule.sourceDecimals ?? 8} symbol={rule.sourceSymbol} />
          </div>
          <div className="rule-meta">
            <Meta k="Pre-event exposure" v={`${math.display.preEventExposure} ${rule.sourceSymbol}`} />
            <Meta k="Dividend created" v={`${math.display.dividendExposure} (${Number(math.display.dividendYieldPct).toFixed(3)}%)`} flow />
            <Meta k="Source preserved" v={`${math.display.remainingExposure} ✓`} />
          </div>
        </>
      )}

      {!isDividend && evaluation.harvestableAtomic && (
        <div className="rule-meta">
          <Meta k="Principal floor" v={formatUsd(rule.principalFloorAtomic)} />
          <Meta k="Earnings above floor" v={formatUsd(evaluation.harvestableAtomic)} flow />
          <Meta k="Principal used" v={`${formatUsd('0')} ✓`} />
        </div>
      )}

      {quote && !quote.error && (
        <div className="rule-meta">
          <Meta k="Expected receive" v={`${formatRaw(quote.outAmount, rule.destinationDecimals ?? 8, 8)} ${rule.destinationSymbol}`} equity />
          <Meta k="Price impact" v={pctFromDecimalString(quote.priceImpactPct)} />
          <Meta k="Max slippage" v={`${rule.maxSlippageBps} bps`} />
          <Meta k="Route" v={(quote.routePlan || []).map((r) => r.label).join(' → ') || '-'} />
        </div>
      )}

      {prepared?.stage === 'WITHDRAW' && (
        <div className="notice warn">
          Step 1 of 2 - withdraw {formatUsd(prepared.context?.harvestableAtomic)} of earnings from Kamino.
          The swap is a separate signature once this confirms. Your principal floor does not move.
        </div>
      )}
      {withdrawSignature && prepared?.stage !== 'WITHDRAW' && (
        <div className="notice ok">
          Step 1 confirmed - earnings are out of the vault and recorded. Step 2 of 2: swap to {rule.destinationSymbol}.
        </div>
      )}
      {prepared?.simulation && !prepared.simulation.ok && (
        <div className="notice bad">Simulation failed; nothing was sent to your wallet.</div>
      )}
      {error && <div className="notice bad">{error}</div>}

      {blocked && (
        <div className="blocked-hero">
          <div className="blocked-title">EXECUTION BLOCKED - CAPITAL FIREWALL</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>{blocked.reason}</div>
          <PremiumGauge premiumBps={blocked.premiumBps} maxPremiumBps={blocked.maxPremiumBps}
                        minPremiumBps={blocked.minPremiumBps} decision="BLOCK" />
          <div className="hint" style={{ marginTop: 8 }}>
            {blocked.tokenPriceUsd && <>Would have paid ${blocked.tokenPriceUsd} ({blocked.tokenSource}). </>}
            {blocked.referencePriceUsd && <>Fair value ${blocked.referencePriceUsd} ({blocked.referenceSource}). </>}
          </div>
          <div className="notice ok" style={{ marginTop: 10 }}>
            Your earnings are untouched. {blocked.detail?.split('. ').slice(-1)[0]} The decision is stored with its
            evidence and counts toward Earnings Retained.
          </div>
        </div>
      )}

      {phase === 'done' ? (
        <div className="notice ok">Executed. The receipt below is the proof.</div>
      ) : (
        <div className="controls">
          {phase === 'review' && prepared?.ok ? (
            <button className="btn flow" onClick={handleExecute} disabled={phase === 'signing' || phase === 'submitting'}>
              {phase === 'signing' ? 'Waiting for wallet…'
                : phase === 'submitting' ? 'Confirming…'
                : prepared.stage === 'WITHDRAW' ? 'Sign withdrawal (1 of 2)'
                : withdrawSignature ? 'Sign swap (2 of 2)' : 'Sign & execute'}
            </button>
          ) : (
            <button className="btn primary" onClick={handlePrepare} disabled={phase === 'preparing' || !connection}>
              {phase === 'preparing' ? 'Checking…' : 'Review & execute'}
            </button>
          )}
          {prepared && <button className="btn" onClick={() => { setPrepared(null); setPhase('idle'); }}>Reset</button>}
        </div>
      )}

      <div className="hint" style={{ marginTop: 10 }}>
        Every guard is re-checked against fresh data at this step. Nothing is marked executed until
        the transaction confirms on Solana.
      </div>
    </div>
  );
}

function buildContext(rule, prepared, evaluation) {
  const math = evaluation.math;
  return {
    intent: prepared.evaluation?.intent ?? evaluation.intent,
    snapshotId: evaluation.snapshot?.id ?? null,
    quote: prepared.quote,
    inputs: {
      symbol: rule.sourceSymbol,
      destinationSymbol: rule.destinationSymbol,
      destinationDecimals: rule.destinationDecimals,
      corporateActionId: evaluation.snapshot?.corporateActionId ?? null,
      reason: evaluation.snapshot?.reason ?? null,
      multiplierBefore: math?.multiplierBefore ?? null,
      multiplierAfter: math?.multiplierAfter ?? null,
      dividendRawAtomic: math?.dividendRawAtomic ?? null,
      preEventExposureDisplay: math?.display?.preEventExposure ?? null,
      dividendExposureDisplay: math?.display?.dividendExposure ?? null,
      remainingExposureDisplay: math?.display?.remainingExposure ?? null,
      principalFloorAtomic: rule.principalFloorAtomic ?? null,
      redeemableAtomic: evaluation.position?.redeemableAtomic ?? null,
      safetyBufferAtomic: evaluation.safetyBufferAtomic ?? null,
      harvestableAtomic: evaluation.harvestableAtomic ?? null,
    },
  };
}

function Meta({ k, v, flow, equity }) {
  return (
    <div>
      <div className="meta-k">{k}</div>
      <div className={`meta-v money ${flow ? 'preserved-yes' : ''} ${equity ? 'equity' : ''}`}>{v}</div>
    </div>
  );
}
