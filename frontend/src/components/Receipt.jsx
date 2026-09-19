import { formatRaw, formatUsd, formatDateTime, explorerUrl, shortAddress } from '../lib/format.js';
import Verdict from './Verdict.jsx';

/**
 * The receipt is the product. It shows the inputs the decision was made on, the
 * outputs, and the preservation proof -- not just a success message.
 */
export default function Receipt({ receipt }) {
  if (!receipt) return null;
  const { inputs = {}, outputs = {}, kind, mode, status } = receipt;
  const isDividend = kind === 'DIVIDEND';
  const failed = status !== 'CONFIRMED';

  return (
    <div className="receipt">
      <div className="receipt-title">
        {isDividend ? 'DIVIDEND RULE' : 'INTEREST RULE'} - {status}
        {mode === 'REPLAY' && ' · REPLAY'}
      </div>
      <Verdict
        verification={receipt.verification}
        note={receipt.verificationNote}
        proofs={receipt.proofs}
      />

      {isDividend ? (
        <>
          <Row k="Source" v={`${inputs.symbol ?? '-'}`} />
          <Row k="Corporate action" v={inputs.corporateActionId ?? '-'} />
          <Row k="Event type" v={inputs.reason ?? '-'} />
          <hr />
          <Row k="Pre-event exposure" v={`${inputs.preEventExposureDisplay ?? '-'} ${inputs.symbol ?? ''}`} />
          <Row k="Multiplier" v={`${inputs.multiplierBefore ?? '?'} → ${inputs.multiplierAfter ?? '?'}`} />
          <Row k="Dividend-created exposure" v={`${inputs.dividendExposureDisplay ?? '-'} ${inputs.symbol ?? ''}`} />
          <Row k="Raw units routed" v={inputs.dividendRawAtomic ?? '-'} />
          <hr />
          <Row k="Routed to" v={inputs.destinationSymbol ?? '-'} className="equity" />
          <Row k="Received" v={outputs.outputAmountResult ? formatRaw(outputs.outputAmountResult, inputs.destinationDecimals ?? 8, 8) : '-'} className="equity" />
          <Row k="Remaining source exposure"
               v={`${outputs.exposureAfter ?? inputs.remainingExposureDisplay ?? '-'} ${inputs.symbol ?? ''} ${receipt.preserved === true ? '✓' : ''}`}
               className={receipt.preserved === true ? 'preserved-yes' : ''} />
        </>
      ) : (
        <>
          <Row k="Principal floor" v={formatUsd(inputs.principalFloorAtomic)} />
          <Row k="Redeemable value" v={formatUsd(inputs.redeemableAtomic)} />
          <Row k="Safety buffer" v={formatUsd(inputs.safetyBufferAtomic)} />
          <Row k="Earnings harvested" v={formatUsd(inputs.harvestableAtomic)} className="preserved-yes" />
          <hr />
          <Row k="Destination" v={inputs.destinationSymbol ?? '-'} className="equity" />
          <Row k="Received" v={outputs.outputAmountResult ? formatRaw(outputs.outputAmountResult, inputs.destinationDecimals ?? 8, 8) : '-'} className="equity" />
          <Row k="Principal used to buy" v={`${formatUsd('0')} ${!failed ? '✓' : ''}`} className={!failed ? 'preserved-yes' : ''} />
        </>
      )}

      <hr />
      {receipt.signature ? (
        <Row k="Solana tx" v={<a href={explorerUrl(receipt.signature)} target="_blank" rel="noreferrer">{shortAddress(receipt.signature, 8)}</a>} />
      ) : (
        <Row k="Solana tx" v="- none -" />
      )}
      {receipt.onchainSignature && (
        <Row k="Registry tx" v={<a href={explorerUrl(receipt.onchainSignature)} target="_blank" rel="noreferrer">{shortAddress(receipt.onchainSignature, 8)}</a>} />
      )}
      <Row k="Timestamp" v={formatDateTime(receipt.createdAt)} />
      {receipt.error && <div className="notice bad" style={{ marginTop: 10 }}>{receipt.error}</div>}
      {status === 'PARTIAL' && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          Earnings were withdrawn but the swap did not confirm. The USDC is in your wallet and
          is recorded as stranded; the next execution sweeps it before withdrawing anything more.
        </div>
      )}
    </div>
  );
}

function Row({ k, v, className = '' }) {
  return (
    <div className="receipt-row">
      <span className="k">{k}</span>
      <span className={`v ${className}`}>{v}</span>
    </div>
  );
}
