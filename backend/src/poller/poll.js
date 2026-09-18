/**
 * Corporate-action detection.
 *
 * Runs on demand (POST /api/poll) or on an interval. It NEVER signs or executes;
 * its only job is to notice a pending event and capture the pre-event snapshot
 * that establishes what the user held when entitlement was struck.
 *
 * The snapshot is the whole point: once the multiplier activates, the pre-event
 * value is gone from the live API, and without it the dividend cannot be
 * isolated from the position.
 */
import { listActiveDividendRules } from '../db/rules.js';
import { upsertSnapshot, getOpenSnapshotForRule } from '../db/snapshots.js';
import { fetchMultiplier, fetchMultiplierHistory } from '../adapters/xstocks/client.js';
import { classifyCorporateAction } from '../adapters/xstocks/corporateActions.js';
import { getTokenBalance, getSlot } from '../adapters/solana/rpc.js';
import { fetchCorporateActions, bindToHistory } from '../adapters/xstocks/corporateActionsFeed.js';
import { reconcileSnapshot } from '../db/snapshots.js';

export async function pollOnce() {
  const rules = listActiveDividendRules();
  const slot = await getSlot().catch(() => null);
  const results = [];

  for (const rule of rules) {
    const symbol = rule.sourceSymbol ?? rule.sourceId;
    try {
      const multiplier = await fetchMultiplier(symbol);

      // Case 1: a pending action is announced but not yet active. Snapshot now.
      if (multiplier.pending) {
        const classification = classifyCorporateAction({ reason: multiplier.reason });
        if (!classification.supported) {
          results.push({ ruleId: rule.id, symbol, action: 'IGNORED_UNSUPPORTED', reason: multiplier.reason, detail: classification.detail });
          continue;
        }
        const existing = getOpenSnapshotForRule(rule.id);
        if (existing && existing.activationDateTime === multiplier.activationDateTime) {
          results.push({ ruleId: rule.id, symbol, action: 'ALREADY_SNAPSHOTTED' });
          continue;
        }
        const balance = await getTokenBalance({ owner: rule.wallet, mint: rule.sourceMint });
        if (BigInt(balance.rawAtomic) === 0n) {
          results.push({ ruleId: rule.id, symbol, action: 'NO_POSITION', detail: 'wallet holds none of this asset' });
          continue;
        }
        const snap = upsertSnapshot({
          ruleId: rule.id,
          wallet: rule.wallet,
          symbol,
          mint: rule.sourceMint,
          // No id is exposed for pending actions, so key on the activation time.
          corporateActionId: `pending:${symbol}:${multiplier.activationDateTime}`,
          reason: multiplier.reason,
          rawBalanceAtomic: balance.rawAtomic,
          multiplierBefore: multiplier.currentMultiplier,
          multiplierAfter: multiplier.newMultiplier,
          activationDateTime: multiplier.activationDateTime,
          snapshotSlot: slot,
        });
        results.push({ ruleId: rule.id, symbol, action: 'SNAPSHOT_CREATED', snapshotId: snap.id, activationDateTime: multiplier.activationDateTime });
        continue;
      }

      // Case 2: nothing pending. If an activation happened since the last poll,
      // bind the open snapshot to the PUBLISHED event. The corporate-actions feed
      // is preferred: a stable event id, exact multiplier strings, and the
      // cashflow and withholding tax. Binding is exact -- no nearest match.
      const open = getOpenSnapshotForRule(rule.id);
      if (open && open.corporateActionId.startsWith('pending:')) {
        const history = await fetchMultiplierHistory(symbol);
        const actions = await fetchCorporateActions(symbol).catch(() => []);
        const bound = actions.map((e) => bindToHistory(e, history)).find(
          (b) => b && Date.parse(b.activationDateTime) === Date.parse(open.activationDateTime),
        );
        if (bound) {
          reconcileSnapshot(open.id, {
            corporateActionId: bound.corporateActionId,
            multiplierBefore: bound.multiplierBefore,
            multiplierAfter: bound.multiplierAfter,
            eventSource: 'CORPORATE_ACTIONS',
            grossCashflowUsd: bound.grossCashflowUsd,
            netCashflowUsd: bound.netCashflowUsd,
            withholdingTaxRate: bound.withholdingTaxRate,
          });
          results.push({ ruleId: rule.id, symbol, action: 'SNAPSHOT_BOUND', corporateActionId: bound.corporateActionId, source: 'CORPORATE_ACTIONS' });
          continue;
        }
        // Fallback: multiplier history alone, still requiring an exact time match.
        const match = history.find((h) => Date.parse(h.activationDateTime) === Date.parse(open.activationDateTime) && h.reason === 'Dividend');
        if (match) {
          reconcileSnapshot(open.id, {
            corporateActionId: match.corporateActionId,
            multiplierBefore: match.multiplierBefore,
            multiplierAfter: match.multiplierAfter,
            eventSource: 'MULTIPLIER_HISTORY',
          });
          results.push({ ruleId: rule.id, symbol, action: 'SNAPSHOT_BOUND', corporateActionId: match.corporateActionId, source: 'MULTIPLIER_HISTORY' });
          continue;
        }
      }
      results.push({ ruleId: rule.id, symbol, action: 'NO_PENDING_EVENT', currentMultiplier: multiplier.currentMultiplier });
    } catch (err) {
      results.push({ ruleId: rule.id, symbol, action: 'ERROR', error: err.message });
    }
  }

  return { polledAt: new Date().toISOString(), slot, rulesChecked: rules.length, results };
}

/** Interval runner used by the server when POLL_INTERVAL_MS is set. */
export function startPoller() {
  const interval = Number(process.env.POLL_INTERVAL_MS || 0);
  if (!interval) return null;
  const timer = setInterval(() => {
    pollOnce()
      .then((r) => { if (r.results.some((x) => x.action === 'SNAPSHOT_CREATED')) console.log('[poller]', JSON.stringify(r.results)); })
      .catch((e) => console.error('[poller] failed:', e.message));
  }, interval);
  timer.unref?.();
  console.log(`[poller] running every ${interval}ms`);
  return timer;
}
