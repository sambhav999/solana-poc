/**
 * xStocks dividend extraction.
 *
 * xStocks on Solana use the Token-2022 Scaled UI Amount extension. A holder's
 * RAW balance never changes on a corporate action; instead the mint's multiplier
 * changes, and wallets display raw * multiplier. A cash dividend is therefore
 * delivered as an increase in effective equity exposure, not as new tokens.
 *
 * Overflow isolates exactly the exposure the dividend created and leaves the
 * pre-event exposure untouched.
 *
 *   want:          remainingRaw * m1 == R * m0
 *   so:            remainingRaw      == R * m0 / m1
 *   therefore:     dividendRaw       == R - R*m0/m1 == R * (m1 - m0) / m1
 *
 * dividendRaw is floored, which rounds remainingRaw UP, which makes
 *
 *   remainingExposure >= preEventExposure
 *
 * hold exactly, with no tolerance required. Everything below is BigInt, so that
 * inequality is a proof and not an approximation.
 *
 * THE DANGEROUS PART: a stock SPLIT also raises the multiplier, and by far more
 * than a dividend does. Observed in live xStocks history: KLACx went 1.000892 ->
 * 10.008923 on a 10:1 split. Feeding that into this formula yields a "dividend"
 * of ~90% of the position. Splits create no economic value, so extracting on one
 * would liquidate nine tenths of the user's holding. Event classification is a
 * safety control, not metadata -- see corporateActions.js.
 */

import { SCALE, parseDecimalToScaled, mulScaled, rawToScaled, formatScaled } from './units.js';

export class DividendMathError extends Error {}

/**
 * @param {object} p
 * @param {string|bigint} p.rawBalanceAtomic  raw Token-2022 balance, atomic units
 * @param {string} p.multiplierBefore         m0, decimal string
 * @param {string} p.multiplierAfter          m1, decimal string
 * @param {number} p.tokenDecimals            mint decimals (display only)
 */
export function extractDividend({ rawBalanceAtomic, multiplierBefore, multiplierAfter, tokenDecimals = 8 }) {
  const R = BigInt(rawBalanceAtomic);
  if (R < 0n) throw new DividendMathError('rawBalanceAtomic must be non-negative');

  const m0 = parseDecimalToScaled(multiplierBefore);
  const m1 = parseDecimalToScaled(multiplierAfter);
  if (m0 <= 0n) throw new DividendMathError('multiplierBefore must be > 0');
  if (m1 <= 0n) throw new DividendMathError('multiplierAfter must be > 0');

  // A dividend can only raise the multiplier. A fall means a reverse split or a
  // correction, and must never reach this function.
  if (m1 <= m0) {
    throw new DividendMathError(
      `multiplierAfter (${multiplierAfter}) must exceed multiplierBefore (${multiplierBefore}); ` +
      'a non-increasing multiplier is not a dividend'
    );
  }

  // dividendRaw = floor( R * (m1 - m0) / m1 ). BigInt division truncates toward
  // zero, which is floor for non-negative operands.
  const dividendRawAtomic = (R * (m1 - m0)) / m1;
  const remainingRawAtomic = R - dividendRawAtomic;

  // Exposure figures are scaled decimals: rawScaled * multiplier.
  const rawScaled = rawToScaled(R, tokenDecimals);
  const remainingRawScaled = rawToScaled(remainingRawAtomic, tokenDecimals);
  const preEventExposure = mulScaled(rawScaled, m0);
  const postEventExposure = mulScaled(rawScaled, m1);
  const remainingExposure = mulScaled(remainingRawScaled, m1);
  const dividendExposure = postEventExposure - preEventExposure;

  const invariantHolds = remainingExposure >= preEventExposure;

  return {
    rawBalanceAtomic: R.toString(),
    dividendRawAtomic: dividendRawAtomic.toString(),
    remainingRawAtomic: remainingRawAtomic.toString(),
    multiplierBefore: formatScaled(m0, 18),
    multiplierAfter: formatScaled(m1, 18),
    preEventExposure: preEventExposure.toString(),
    postEventExposure: postEventExposure.toString(),
    remainingExposure: remainingExposure.toString(),
    dividendExposure: dividendExposure.toString(),
    display: {
      preEventExposure: formatScaled(preEventExposure, tokenDecimals),
      postEventExposure: formatScaled(postEventExposure, tokenDecimals),
      remainingExposure: formatScaled(remainingExposure, tokenDecimals),
      dividendExposure: formatScaled(dividendExposure, tokenDecimals),
      dividendYieldPct: formatScaled((dividendExposure * 100n * SCALE) / (preEventExposure || 1n), 6),
    },
    invariantHolds,
    // Surplus left with the user purely from flooring. Never negative.
    preservationSurplus: (remainingExposure - preEventExposure).toString(),
  };
}

/**
 * The gate that runs immediately before a transaction is built. It re-derives the
 * numbers rather than trusting anything carried along with the request, and
 * returns a hard stop rather than a warning.
 */
export function assertSourcePreserved(result) {
  const remaining = BigInt(result.remainingExposure);
  const pre = BigInt(result.preEventExposure);
  if (remaining < pre) {
    return {
      ok: false,
      reason: 'SOURCE_NOT_PRESERVED',
      detail: `remainingExposure ${remaining} < preEventExposure ${pre}`,
    };
  }
  if (BigInt(result.dividendRawAtomic) <= 0n) {
    return { ok: false, reason: 'NO_DIVIDEND_EXPOSURE', detail: 'dividend rounds to zero raw units' };
  }
  if (BigInt(result.dividendRawAtomic) >= BigInt(result.rawBalanceAtomic)) {
    return { ok: false, reason: 'EXTRACTION_EXCEEDS_BALANCE', detail: 'refusing to route the entire position' };
  }
  return { ok: true };
}

/**
 * Independent sanity bound. Even a correctly classified dividend should not move
 * a large fraction of a position; a real one is well under 5%. If the maths says
 * otherwise, the event was probably misclassified upstream, so stop.
 */
export function dividendPlausibilityCheck(result, maxFractionBps = 500) {
  const div = BigInt(result.dividendRawAtomic);
  const total = BigInt(result.rawBalanceAtomic);
  if (total === 0n) return { ok: false, reason: 'ZERO_BALANCE' };
  const bps = (div * 10000n) / total;
  if (bps > BigInt(maxFractionBps)) {
    return {
      ok: false,
      reason: 'IMPLAUSIBLE_DIVIDEND_SIZE',
      detail: `extraction is ${bps} bps of the position, above the ${maxFractionBps} bps ceiling`,
      bps: bps.toString(),
    };
  }
  return { ok: true, bps: bps.toString() };
}
