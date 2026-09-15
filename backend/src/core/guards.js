/**
 * Pre-signature execution guards. Every one of these must pass, and they are
 * re-evaluated against fresh data immediately before a transaction is built --
 * never trusted from an earlier evaluation.
 */

export const DEFAULT_MAX_PRICE_IMPACT_BPS = 100; // 1%
export const DEFAULT_MAX_SLIPPAGE_BPS = 50;

/** Guard a Jupiter quote before it is shown for signature. */
export function quoteGuard({ quote, maxPriceImpactBps = DEFAULT_MAX_PRICE_IMPACT_BPS, maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS }) {
  if (!quote) return { ok: false, reason: 'NO_QUOTE', detail: 'no route returned' };

  const inAmount = BigInt(quote.inAmount ?? 0);
  const outAmount = BigInt(quote.outAmount ?? 0);
  if (inAmount <= 0n) return { ok: false, reason: 'ZERO_INPUT' };
  if (outAmount <= 0n) return { ok: false, reason: 'NO_OUTPUT' };

  // priceImpactPct arrives as a decimal string percentage, e.g. "0.00104".
  const impactBps = percentStringToBps(quote.priceImpactPct ?? '0');
  if (impactBps === null) return { ok: false, reason: 'UNREADABLE_PRICE_IMPACT', detail: String(quote.priceImpactPct) };
  if (impactBps > BigInt(maxPriceImpactBps)) {
    return {
      ok: false,
      reason: 'PRICE_IMPACT_TOO_HIGH',
      detail: `${impactBps} bps exceeds ceiling of ${maxPriceImpactBps} bps`,
      impactBps: impactBps.toString(),
    };
  }

  const quotedSlippage = Number(quote.slippageBps ?? maxSlippageBps);
  if (Number.isFinite(quotedSlippage) && quotedSlippage > maxSlippageBps) {
    return { ok: false, reason: 'SLIPPAGE_ABOVE_LIMIT', detail: `quote slippage ${quotedSlippage} bps > ${maxSlippageBps} bps` };
  }

  return { ok: true, impactBps: impactBps.toString(), outAmount: outAmount.toString() };
}

/** "0.00104" (percent) -> 10 bps, as BigInt, without floats. */
export function percentStringToBps(pct) {
  const s = String(pct).trim();
  if (!/^-?\d*\.?\d*(?:[eE][-+]?\d+)?$/.test(s) || s === '' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Percent -> bps is x100; ceil so a borderline quote is treated as the worse case.
  return BigInt(Math.ceil(Math.abs(n) * 100));
}

/**
 * Trading-window guard. xStocks publishes tradingHoursMode / currentPeriod /
 * openNow per asset. Dividend activations land at 00:30 UTC, which is outside US
 * market hours, so this keeps executions away from the thinnest book of the day
 * unless the operator explicitly allows it.
 */
export function tradingWindowGuard({ asset, allowOvernight = false }) {
  if (!asset) return { ok: false, reason: 'UNKNOWN_ASSET' };
  if (asset.isTradingHalted) return { ok: false, reason: 'TRADING_HALTED' };
  const period = asset.trading?.currentPeriod ?? null;
  const openNow = asset.trading?.openNow ?? null;
  if (openNow === false) return { ok: false, reason: 'MARKET_CLOSED', detail: `period=${period}` };
  if (!allowOvernight && (period === 'overnight' || period === 'closed')) {
    return {
      ok: false,
      reason: 'THIN_LIQUIDITY_WINDOW',
      detail: `current period is "${period}"; waiting for a deeper book. Override with allowOvernight.`,
      period,
    };
  }
  return { ok: true, period };
}

/** Minimum economical execution size. Below this the rule waits rather than executing. */
export function thresholdGuard({ valueUsdAtomic, minExecutionUsdAtomic }) {
  const value = BigInt(valueUsdAtomic);
  const min = BigInt(minExecutionUsdAtomic);
  if (value < min) {
    return {
      ok: false,
      reason: 'BELOW_THRESHOLD',
      shortfallAtomic: (min - value).toString(),
      detail: 'earnings remain pending; nothing is consumed',
    };
  }
  return { ok: true };
}
