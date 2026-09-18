/**
 * Live preview: what executing a rule would do right now, with no side effects.
 *
 * It prepares no transaction, withdraws nothing, and writes no firewall
 * decision. Everything it returns is labelled PREVIEW so it can never be
 * mistaken for an execution.
 */
import { evaluateRule } from './evaluate.js';
import { runFirewall } from './firewall.js';
import { USDC_MINT } from '../adapters/solana/rpc.js';
import { STATUS } from '../core/ruleEngine.js';

export async function previewRule(rule) {
  const evaluation = await evaluateRule(rule);
  const base = {
    mode: 'PREVIEW',
    notice: 'Preview only. No transaction has been prepared or signed, and nothing has moved.',
    rule: { id: rule.id, sourceType: rule.sourceType, destinationSymbol: rule.destinationSymbol, destinationProvider: rule.destinationProvider },
    status: evaluation.status,
    reason: evaluation.reason,
    guards: evaluation.guards,
  };

  if (evaluation.status !== STATUS.READY) {
    return {
      ...base,
      wouldExecute: false,
      harvestableAtomic: evaluation.harvestableAtomic ?? null,
      principalFloorAtomic: rule.principalFloorAtomic ?? null,
      redeemableAtomic: evaluation.position?.redeemableAtomic ?? null,
      math: evaluation.math ?? null,
    };
  }

  const amountAtomic = evaluation.intent.inputRawAtomic;
  const inputMint = rule.sourceType === 'KAMINO_USDC' ? USDC_MINT : evaluation.intent.inputMint;
  const firewall = await runFirewall({
    rule, amountAtomic, inputMint, intentKey: `preview:${rule.id}`, dryRun: true,
  }).catch((err) => ({ decision: 'BLOCK', breach: 'NO_EVIDENCE', reason: `Firewall preview failed: ${err.message}` }));

  const blocked = firewall.decision === 'BLOCK';
  return {
    ...base,
    wouldExecute: !blocked,
    outcome: blocked ? 'WOULD_BE_BLOCKED' : 'WOULD_EXECUTE',
    amountAtomic,
    harvestableAtomic: evaluation.harvestableAtomic ?? null,
    principalFloorAtomic: rule.principalFloorAtomic ?? null,
    redeemableAtomic: evaluation.position?.redeemableAtomic ?? null,
    math: evaluation.math ?? null,
    firewall: {
      decision: firewall.decision,
      breach: firewall.breach ?? null,
      reason: firewall.reason,
      premiumBps: firewall.premiumBps ?? null,
      maxPremiumBps: firewall.maxPremiumBps ?? null,
      minPremiumBps: firewall.minPremiumBps ?? null,
      tokenPriceUsd: firewall.tokenPriceUsd ?? null,
      referencePriceUsd: firewall.referencePriceUsd ?? null,
      tokenSource: firewall.tokenSource ?? null,
      referenceSource: firewall.referenceSource ?? null,
    },
    expectedOutRaw: firewall.quote?.outAmount ?? null,
    route: firewall.quote?.routePlan?.map((r) => r.label).join(' → ') ?? null,
  };
}
