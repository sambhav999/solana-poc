/**
 * Execution keys. A key is claimed before a transaction is built and released
 * only if the attempt provably did not land. Both rule types need one: the
 * dividend rule so a corporate action cannot be harvested twice, the interest
 * rule so a double-click cannot double-withdraw.
 */
import { createHash } from 'node:crypto';

export function dividendExecutionKey({ wallet, corporateActionId, symbol, activationDateTime }) {
  return sha256(['dividend', wallet, corporateActionId, symbol, activationDateTime].join('|'));
}

/**
 * Interest harvests recur, so the key is scoped to the observation that made the
 * rule ready rather than to the rule alone.
 */
export function interestExecutionKey({ wallet, ruleId, observedSlot, harvestableAtomic }) {
  return sha256(['interest', wallet, ruleId, String(observedSlot), String(harvestableAtomic)].join('|'));
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}
