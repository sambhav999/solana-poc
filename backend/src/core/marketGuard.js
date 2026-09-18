/**
 * Capital Firewall.
 *
 * Refuses to route earnings into a token trading too far from fair value. The
 * question it answers is "am I about to overpay?", so the TOKEN price must be
 * what the user actually PAYS -- the executable Jupiter quote -- and not a price
 * some provider reports. Where no quote is available it falls back to the
 * provider's token price; where there is neither, it FAILS CLOSED.
 *
 * Two corrections over V4.1:
 *
 *   1. The implied price is multiplier-aware. Jupiter's outAmount is RAW. Several
 *      private-market mints are Token-2022 with a scaled UI multiplier (PreStocks
 *      OpenAI: 1.486), so the naive price is wrong by that factor -- 6717 bps of
 *      "premium" that does not exist. The exact thing this product is built to
 *      avoid, reappearing one layer up.
 *
 *   2. The band is two-sided. V4.1 only capped the premium, so a token at a 21%
 *      DISCOUNT to its mark passed. A stale mark, a broken token or an illiquid
 *      book all look exactly like that. `minPremiumBps` closes it; null keeps
 *      V4.1's one-sided behaviour.
 *
 * All comparison is exact integer arithmetic: no rounding decides a PASS.
 */
import { parseDecimalToScaled, SCALE } from './units.js';

export const GUARD_MODES = ['NONE', 'TOKEN_PREMIUM', 'PYTH_PARITY'];

/**
 * Price per UI token implied by a quote, as a 1e18-scaled integer.
 *
 *   price = usdcIn / (rawOut / 10^decimals * multiplier)
 */
export function impliedTokenPriceScaled({ inAmountAtomic, inDecimals = 6, outAmountRaw, outDecimals, multiplier = '1' }) {
  const inAmt = BigInt(inAmountAtomic);
  const outRaw = BigInt(outAmountRaw);
  if (inAmt <= 0n || outRaw <= 0n) throw new Error('implied price needs positive in and out amounts');
  const mult = parseDecimalToScaled(multiplier);
  if (mult <= 0n) throw new Error('multiplier must be positive');
  // numerator:   inAmt * 10^outDecimals * SCALE * SCALE
  // denominator: 10^inDecimals * outRaw * mult
  const num = inAmt * 10n ** BigInt(outDecimals) * SCALE * SCALE;
  const den = 10n ** BigInt(inDecimals) * outRaw * mult;
  return num / den;
}

/** Premium in basis points, for DISPLAY. Decisions never use this rounded figure. */
export function premiumBpsDisplay(tokenScaled, referenceScaled) {
  const t = BigInt(tokenScaled);
  const r = BigInt(referenceScaled);
  if (r <= 0n) throw new Error('reference price must be positive');
  // round half away from zero, on a value we only show
  const x = (t * 10000n * 10n) / r - 100000n;
  return Number(x >= 0n ? (x + 5n) / 10n : (x - 5n) / 10n);
}

/**
 * Decide PASS / BLOCK exactly.
 *   upper:  token * 10000 <= reference * (10000 + maxBps)
 *   lower:  token * 10000 >= reference * (10000 + minBps)   (only if minBps set)
 */
export function decideBand({ tokenScaled, referenceScaled, maxPremiumBps, minPremiumBps = null }) {
  const t = BigInt(tokenScaled) * 10000n;
  const r = BigInt(referenceScaled);
  const aboveMax = t > r * (10000n + BigInt(maxPremiumBps));
  const belowMin = minPremiumBps !== null && minPremiumBps !== undefined
    && t < r * (10000n + BigInt(minPremiumBps));
  if (aboveMax) return { pass: false, breach: 'ABOVE_MAX' };
  if (belowMin) return { pass: false, breach: 'BELOW_MIN' };
  return { pass: true, breach: null };
}

/**
 * Evaluate a rule's firewall against a destination.
 *
 * @param rule        { marketGuardMode, maxPremiumBps, minPremiumBps }
 * @param destination { symbol, provider, markPriceUsd, providerTokenPriceUsd, benchmarkSymbol }
 * @param market      { quote?, outDecimals?, multiplier?, pythPrice? } live inputs
 */
export async function evaluateFirewall(rule, destination, market = {}) {
  const observedAt = new Date().toISOString();
  const mode = rule.marketGuardMode ?? 'NONE';

  if (mode === 'NONE') {
    return { mode, decision: 'NOT_REQUIRED', reason: 'No market-price policy on this rule.', observedAt };
  }
  if (rule.maxPremiumBps === null || rule.maxPremiumBps === undefined) {
    return { mode, decision: 'BLOCK', reason: 'Firewall is on but no maximum premium is set; failing closed.', observedAt };
  }

  // Reference: what the token SHOULD be worth.
  let reference = null;
  let referenceSource = null;
  try {
    if (mode === 'TOKEN_PREMIUM') {
      reference = destination.markPriceUsd;
      referenceSource = `${destination.provider} mark`;
    } else if (mode === 'PYTH_PARITY') {
      if (!market.pythPrice) throw new Error('no Pyth price supplied');
      reference = await market.pythPrice(`Equity.US.${destination.benchmarkSymbol ?? destination.symbol.replace(/x$/i, '')}/USD`);
      referenceSource = `Pyth Equity.US.${destination.benchmarkSymbol ?? destination.symbol.replace(/x$/i, '')}/USD`;
    }
  } catch (err) {
    return block(mode, rule, observedAt, `Reference price unavailable (${err.message}); failing closed.`);
  }
  if (!reference) return block(mode, rule, observedAt, 'No reference price for this asset; failing closed.');

  // Token: what the user would actually PAY. Prefer the executable quote.
  let tokenScaled = null;
  let tokenSource = null;
  if (market.quote && market.outDecimals !== undefined) {
    try {
      tokenScaled = impliedTokenPriceScaled({
        inAmountAtomic: market.quote.inAmount,
        outAmountRaw: market.quote.outAmount,
        outDecimals: market.outDecimals,
        multiplier: market.multiplier ?? '1',
      });
      tokenSource = `Jupiter executable quote${market.multiplier && market.multiplier !== '1' ? ` (×${market.multiplier} scaled UI multiplier applied)` : ''}`;
    } catch { /* fall through to the provider price */ }
  }
  if (tokenScaled === null && destination.providerTokenPriceUsd) {
    tokenScaled = parseDecimalToScaled(destination.providerTokenPriceUsd);
    tokenSource = `${destination.provider} reported token price`;
  }
  if (tokenScaled === null) {
    return block(mode, rule, observedAt, 'No token price available (no quote, no provider price); failing closed.', { reference, referenceSource });
  }

  const referenceScaled = parseDecimalToScaled(reference);
  const band = decideBand({
    tokenScaled, referenceScaled,
    maxPremiumBps: rule.maxPremiumBps,
    minPremiumBps: rule.minPremiumBps ?? null,
  });
  const premium = premiumBpsDisplay(tokenScaled, referenceScaled);
  const tokenUsd = formatUsd(tokenScaled);

  let reason;
  if (band.pass) {
    reason = `Premium ${premium} bps is inside the policy band`
      + (rule.minPremiumBps != null ? ` [${rule.minPremiumBps}, ${rule.maxPremiumBps}] bps.` : ` (max ${rule.maxPremiumBps} bps).`);
  } else if (band.breach === 'ABOVE_MAX') {
    reason = `Premium ${premium} bps exceeds the ${rule.maxPremiumBps} bps maximum: this would overpay for ${destination.symbol}.`;
  } else {
    reason = `Premium ${premium} bps is below the ${rule.minPremiumBps} bps floor: a price this far under fair value suggests a stale mark or a broken market.`;
  }

  return {
    mode,
    decision: band.pass ? 'PASS' : 'BLOCK',
    breach: band.breach,
    reason,
    observedAt,
    premiumBps: premium,
    maxPremiumBps: rule.maxPremiumBps,
    minPremiumBps: rule.minPremiumBps ?? null,
    referencePriceUsd: String(reference),
    tokenPriceUsd: tokenUsd,
    referenceSource,
    tokenSource,
  };
}

function block(mode, rule, observedAt, reason, extra = {}) {
  return {
    mode, decision: 'BLOCK', breach: 'NO_EVIDENCE', reason, observedAt,
    maxPremiumBps: rule.maxPremiumBps ?? null, minPremiumBps: rule.minPremiumBps ?? null, ...extra,
  };
}

function formatUsd(scaled) {
  const whole = scaled / SCALE;
  const frac = (scaled % SCALE).toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${frac}`;
}
