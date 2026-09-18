/**
 * "Your Earnings Built This" and "Earnings Retained".
 *
 * Built from records, never from a running counter: every dollar in either figure
 * traces to a specific receipt or policy decision the user can open and audit.
 *
 *   Built    = earnings DEPLOYED, from confirmed receipts, split by what they
 *              bought (public stocks vs private-market tokens). Only receipts the
 *              chain proved count as verified; the rest are shown separately.
 *   Retained = earnings the Capital Firewall declined to spend on a PRICE
 *              judgement. Blocks for missing data are excluded.
 */
import { listReceipts } from '../db/receipts.js';
import { earningsRetained, listDecisions } from '../db/decisions.js';

const CATEGORIES = ['PUBLIC_STOCK', 'PRIVATE_MARKET', 'STABLE'];

export function incomePortfolio(wallet) {
  const receipts = listReceipts(wallet, 1000).filter(
    (r) => r.status === 'CONFIRMED' && (r.kind === 'DIVIDEND' || r.kind === 'INTEREST'),
  );

  const empty = () => ({ verifiedAtomic: 0n, unverifiedAtomic: 0n, executions: 0 });
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, empty()]));
  const byAsset = new Map();
  let verified = 0n;
  let unverified = 0n;

  for (const r of receipts) {
    const value = BigInt(r.earningsUsdAtomic ?? '0');
    const isVerified = r.verification === 'VERIFIED_ON_CHAIN';
    const category = CATEGORIES.includes(r.destinationCategory) ? r.destinationCategory : 'PUBLIC_STOCK';

    if (isVerified) { verified += value; byCategory[category].verifiedAtomic += value; }
    else { unverified += value; byCategory[category].unverifiedAtomic += value; }
    byCategory[category].executions += 1;

    const key = `${category}:${r.destinationSymbol ?? 'UNKNOWN'}`;
    const a = byAsset.get(key) ?? { symbol: r.destinationSymbol, category, verifiedAtomic: 0n, unverifiedAtomic: 0n, executions: 0, bySource: {} };
    if (isVerified) a.verifiedAtomic += value; else a.unverifiedAtomic += value;
    a.executions += 1;
    a.bySource[r.kind] = (a.bySource[r.kind] ?? 0) + 1;
    byAsset.set(key, a);
  }

  const retained = earningsRetained(wallet);
  const decisions = listDecisions(wallet, 200);

  return {
    built: {
      verifiedAtomic: verified.toString(),
      unverifiedAtomic: unverified.toString(),
      executions: receipts.length,
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, {
        verifiedAtomic: v.verifiedAtomic.toString(),
        unverifiedAtomic: v.unverifiedAtomic.toString(),
        executions: v.executions,
      }])),
      holdings: [...byAsset.values()]
        .map((a) => ({ ...a, verifiedAtomic: a.verifiedAtomic.toString(), unverifiedAtomic: a.unverifiedAtomic.toString() }))
        .sort((x, y) => (BigInt(y.verifiedAtomic) > BigInt(x.verifiedAtomic) ? 1 : -1)),
    },
    retained,
    firewall: {
      decisions: decisions.length,
      passed: decisions.filter((d) => d.outcome === 'PASSED').length,
      blocked: decisions.filter((d) => d.outcome === 'BLOCKED').length,
    },
  };
}
