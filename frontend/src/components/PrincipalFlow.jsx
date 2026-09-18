import { formatUsd } from '../lib/format.js';

/**
 * The product, in one picture.
 *
 * The principal floor is a fixed grey mass with a hard line on top. That line
 * NEVER moves: it is a stored ledger value, not a reading of the position. Yield
 * accumulates strictly above it, and only that column is ever spent.
 *
 * Everything here is driven by live evaluation data, so the visual and the
 * accounting cannot drift apart -- the column height is literally
 * harvestable / threshold.
 */
export default function PrincipalFlow({ rule, evaluation, totalInvestedAtomic = '0', portfolioValueAtomic = null }) {
  const floor = BigInt(rule.principalFloorAtomic ?? '0');
  const harvestable = BigInt(evaluation?.harvestableAtomic ?? '0');
  const threshold = BigInt(rule.minExecutionUsdAtomic ?? '1');
  const buffer = BigInt(evaluation?.safetyBufferAtomic ?? rule.safetyBufferAtomic ?? '0');
  const redeemable = BigInt(evaluation?.position?.redeemableAtomic ?? '0');

  const impaired = redeemable > 0n && redeemable < floor;
  const ready = harvestable >= threshold && threshold > 0n;

  // Column height tracks progress toward the execution threshold, capped so a
  // large pending balance cannot overflow the frame.
  const pct = threshold > 0n
    ? Math.min(100, Number((harvestable * 100n) / threshold))
    : (harvestable > 0n ? 100 : 0);
  const columnHeight = harvestable > 0n ? Math.max(6, (pct / 100) * 88) : 0;

  return (
    <div className="card tight">
      <div className="section-title" style={{ marginBottom: 14 }}>
        Savings generate yield · yield builds the portfolio
      </div>

      <div className="flow">
        <div className="flow-col" aria-hidden="true">
          <div className={`flow-yield ${ready ? 'ready' : ''}`} style={{ height: `${columnHeight}px` }}>
            {harvestable > 0n && columnHeight > 16 && (
              <span className="flow-yield-label">{formatUsd(harvestable)}</span>
            )}
          </div>
          <div className="flow-line" />
          <div className="flow-principal">
            <span className="flow-principal-label">
              PRINCIPAL<br />{formatUsd(floor)}<br />locked
            </span>
          </div>
        </div>

        <div className="flow-facts">
          <div className="flow-fact">
            <span className="k">Principal floor - never moves</span>
            <span className="v locked">{formatUsd(floor)}</span>
          </div>
          <div className="flow-fact">
            <span className="k">Kamino position value</span>
            <span className="v">{redeemable > 0n ? formatUsd(redeemable) : '-'}</span>
          </div>
          <div className="flow-fact">
            <span className="k">Yield above the line</span>
            <span className="v flow">{formatUsd(harvestable)}</span>
          </div>
          <div className="flow-fact">
            <span className="k">Yield invested so far</span>
            <span className="v equity">{formatUsd(totalInvestedAtomic)}</span>
          </div>
          <div className="flow-fact">
            <span className="k">Principal used to buy stocks</span>
            <span className="v locked">{formatUsd('0')} ✓</span>
          </div>

          <div>
            <div className="flow-fact" style={{ borderBottom: 'none', paddingBottom: 2 }}>
              <span className="k">
                {ready ? 'Threshold reached - ready to invest' : `Next investment at ${formatUsd(threshold)}`}
              </span>
              <span className="v flow" style={{ fontSize: 12 }}>{pct.toFixed(0)}%</span>
            </div>
            <div className="threshold-track">
              <div className="threshold-fill" style={{ width: `${pct}%` }} />
            </div>
            {buffer > 0n && (
              <div className="hint">
                A {formatUsd(buffer)} safety buffer sits above the floor and is never harvested,
                absorbing exchange-rate drift between reading and executing.
              </div>
            )}
          </div>
        </div>
      </div>

      {impaired && (
        <div className="notice bad">
          The lending position is worth {formatUsd(redeemable)}, which is{' '}
          {formatUsd(floor - redeemable)} below your stored principal floor. There is no yield to
          invest, and principal is not guaranteed.
        </div>
      )}
    </div>
  );
}
