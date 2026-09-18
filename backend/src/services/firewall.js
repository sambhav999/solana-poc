/**
 * Run the Capital Firewall for an execution and persist its decision.
 *
 * For an INTEREST rule this runs BEFORE the Kamino withdrawal. Blocking after
 * withdrawing would strand the earnings as loose USDC in the wallet; blocking
 * first means "earnings remain untouched" is literally true -- they never leave
 * the vault.
 */
import { evaluateFirewall } from '../core/marketGuard.js';
import { getDestination } from './destinations.js';
import { getOrder } from '../adapters/jupiter/client.js';
import { getMintInfo } from '../adapters/solana/rpc.js';
import { pythPriceUsd } from '../adapters/pyth/client.js';
import { recordDecision } from '../db/decisions.js';
import { parseDecimalToScaled } from '../core/units.js';

/** Breaches that reflect a judgement about PRICE, as opposed to missing data. */
export const POLICY_BREACHES = new Set(['ABOVE_MAX', 'BELOW_MIN']);

export async function runFirewall({ rule, amountAtomic, inputMint, intentKey, quote = null, dryRun = false }) {
  const destination = await getDestination(rule.destinationProvider, rule.destinationSymbol);
  if (!destination) {
    return { decision: 'BLOCK', breach: 'NO_EVIDENCE', reason: `Destination ${rule.destinationSymbol} is no longer available.` };
  }
  if ((rule.marketGuardMode ?? 'NONE') === 'NONE') {
    return { decision: 'NOT_REQUIRED', reason: 'No market-price policy on this rule.', destination };
  }

  // What the user would actually pay: a live, executable quote for this amount.
  let q = quote;
  if (!q) {
    try {
      q = await getOrder({ inputMint, outputMint: destination.mint, amountRawAtomic: amountAtomic, slippageBps: rule.maxSlippageBps });
    } catch { q = null; } // evaluateFirewall falls back to the provider price, or fails closed
  }

  // Decimals and the scaled-UI multiplier come from chain, never assumed.
  let outDecimals;
  let multiplier = '1';
  try {
    const mint = await getMintInfo(destination.mint);
    outDecimals = mint.decimals;
    multiplier = mint.effectiveMultiplier ?? '1';
  } catch { /* without decimals the quote cannot be priced; the provider price is used instead */ }

  const evaluation = await evaluateFirewall(rule, destination, {
    quote: q && outDecimals !== undefined ? q : null,
    outDecimals,
    multiplier,
    pythPrice: pythPriceUsd,
  });

  const earningsUsdAtomic = earningsInUsd({ rule, amountAtomic, quote: q });

  // A preview must never write a decision: previewing a blocked rule ten times
  // would otherwise count its earnings as "retained" ten times.
  if (dryRun) return { ...evaluation, destination, earningsUsdAtomic, quote: q, dryRun: true };

  const decision = recordDecision({
    wallet: rule.wallet,
    ruleId: rule.id,
    intentKey,
    destinationSymbol: destination.symbol,
    destinationProvider: destination.provider,
    destinationCategory: destination.category,
    outcome: evaluation.decision === 'PASS' ? 'PASSED' : 'BLOCKED',
    earningsUsdAtomic,
    evidence: {
      ...evaluation,
      destinationMint: destination.mint,
      amountAtomic: String(amountAtomic),
      quotedOutRaw: q?.outAmount ?? null,
      multiplier,
      outDecimals: outDecimals ?? null,
      // Only a price judgement counts toward "earnings retained".
      countsAsRetained: evaluation.decision !== 'PASS' && POLICY_BREACHES.has(evaluation.breach),
    },
  });

  return { ...evaluation, destination, decisionId: decision.id, earningsUsdAtomic, quote: q };
}

/** The USD value of the earnings being routed, in 6-decimal atomic units. */
function earningsInUsd({ rule, amountAtomic, quote }) {
  // Interest is already USDC.
  if (rule.sourceType === 'KAMINO_USDC') return String(amountAtomic);
  // A dividend is a raw xStock quantity; Jupiter values the input leg in USD.
  const usd = quote?.inUsdValue;
  if (usd === null || usd === undefined) return '0';
  try {
    return (parseDecimalToScaled(String(usd)) / 10n ** 12n).toString();
  } catch {
    return '0';
  }
}
