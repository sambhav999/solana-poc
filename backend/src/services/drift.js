/**
 * External-change detection.
 *
 * Overflow's accounting assumes it is the only thing moving the position. It is
 * not: a user can deposit or withdraw in the Kamino UI, or send xStocks from
 * their wallet, at any time.
 *
 * When that happens the stored principal floor and the dividend attribution
 * baseline no longer describe reality, so the rule is PAUSED rather than allowed
 * to compute against a position it no longer understands. Re-confirming the
 * baseline is a deliberate user action.
 */
import { getTokenBalance } from '../adapters/solana/rpc.js';
import { readPosition } from '../adapters/kamino/vault.js';
import { updateRule } from '../db/rules.js';

/** Tolerance for share-balance comparison: yield accrual alone must not trip a pause. */
const SHARE_DRIFT_TOLERANCE = 0n;

export async function checkDividendBaseline(rule) {
  if (!rule.sourceRawBaseline) return { ok: true, reason: 'NO_BASELINE' };
  const live = await getTokenBalance({ owner: rule.wallet, mint: rule.sourceMint }).catch(() => null);
  if (!live) return { ok: true, unverified: true, reason: 'BALANCE_UNREADABLE' };

  if (live.rawAtomic !== String(rule.sourceRawBaseline)) {
    return {
      ok: false,
      reason: 'SOURCE_BALANCE_DRIFT',
      baseline: String(rule.sourceRawBaseline),
      observed: live.rawAtomic,
      detail: `Your ${rule.sourceSymbol} balance changed outside Overflow (${rule.sourceRawBaseline} → ${live.rawAtomic} raw). Dividend attribution is paused until the baseline is reconfirmed.`,
    };
  }
  return { ok: true, observed: live.rawAtomic };
}

export async function checkVaultBaseline(rule) {
  if (!rule.vaultSharesBaseline) return { ok: true, reason: 'NO_BASELINE' };
  const position = await readPosition({ owner: rule.wallet, vaultAddress: rule.kaminoVault }).catch(() => null);
  if (!position?.available) return { ok: true, unverified: true, reason: 'POSITION_UNREADABLE' };

  const baseline = BigInt(rule.vaultSharesBaseline);
  const observed = BigInt(position.sharesAtomic ?? '0');
  // Shares do NOT grow with yield -- the exchange rate does -- so any change in
  // share count is external activity, not accrual.
  const delta = observed > baseline ? observed - baseline : baseline - observed;
  if (delta > SHARE_DRIFT_TOLERANCE) {
    return {
      ok: false,
      reason: 'VAULT_SHARES_DRIFT',
      baseline: baseline.toString(),
      observed: observed.toString(),
      detail: `Your Kamino share balance changed outside Overflow (${baseline} → ${observed}). The stored principal floor may no longer be correct, so the rule is paused until you reconfirm it.`,
    };
  }
  return { ok: true, observed: observed.toString() };
}

/** Pause a rule and record why, so the UI can explain it and offer a fix. */
export function pauseForDrift(ruleId, reason, detail) {
  return updateRule(ruleId, { status: 'PAUSED', pauseReason: `${reason}: ${detail}` });
}

/** Record what Overflow now believes the position to be. */
export async function refreshBaselines(rule) {
  const patch = { baselineUpdatedAt: new Date().toISOString(), pauseReason: null };
  if (rule.sourceType === 'XSTOCK_DIVIDEND' && rule.sourceMint) {
    const live = await getTokenBalance({ owner: rule.wallet, mint: rule.sourceMint }).catch(() => null);
    if (live) patch.sourceRawBaseline = live.rawAtomic;
  }
  if (rule.sourceType === 'KAMINO_USDC' && rule.kaminoVault) {
    const position = await readPosition({ owner: rule.wallet, vaultAddress: rule.kaminoVault }).catch(() => null);
    if (position?.available) patch.vaultSharesBaseline = position.sharesAtomic ?? '0';
  }
  return updateRule(rule.id, patch);
}
