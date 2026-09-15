import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import type { Rule, ExecutionIntent, EvaluationResult } from './types';
import {
  latestCashDividend,
  resolveMultiplierPair,
  solanaMintFor,
  multiplierIsLive,
  assetPriceUsd,
  currentMultiplierState,
} from './xstocks';
import { rawTokenBalance } from './solana';
import {
  dividendRawAtomic,
  sourceExposurePreserved,
  harvestableInterestUsd,
  scaledExposure,
  defaultSafetyBufferUsd,
  harvestPlausible,
} from './math';
import { getKaminoVaultSnapshot, sharesForWithdrawal } from './kamino';
import { isEventProcessed, saveIntent, getLatestIntentForRule } from './repository';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function blocked(
  status: EvaluationResult['status'],
  reason: string,
  extra: Partial<EvaluationResult> = {}
): EvaluationResult {
  return {
    ready: false,
    status,
    reason,
    guards: { idempotent: true, threshold: false, sourcePreserved: false, ...(extra.guards || {}) },
    debug: extra.debug,
  };
}

function safeAfter(activationAt: string) {
  const mins = Number(process.env.DIVIDEND_SAFETY_WINDOW_MINUTES || 15);
  const t = Date.parse(activationAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() >= t + mins * 60_000;
}

export async function evaluateRule(rule: Rule): Promise<EvaluationResult> {
  if (rule.status !== 'ACTIVE') return blocked('WAITING', 'Rule paused');
  return rule.kind === 'XSTOCK_DIVIDEND' ? evaluateDividend(rule) : evaluateInterest(rule);
}

/* ------------------------- dividend ------------------------- */

async function evaluateDividend(rule: Rule): Promise<EvaluationResult> {
  const event = await latestCashDividend(rule.sourceSymbol);
  if (!event) return blocked('WAITING', 'No cash-dividend event found');

  if (await isEventProcessed(rule.id, event.eventId)) {
    return blocked('WAITING', 'This dividend has already been routed by this rule');
  }
  if (event.eventId === rule.baselineEventId) {
    return blocked('WAITING', 'No new dividend since rule activation');
  }

  // Exact event linkage only. Never substitute a nearby/recent multiplier pair.
  const pair = await resolveMultiplierPair(rule.sourceSymbol, event.eventId);
  if (!pair) {
    return blocked('BLOCKED', 'Could not match this corporate action to a multiplier change — refusing to guess', {
      guards: {
        idempotent: true,
        threshold: false,
        eventType: true,
        activationSafe: false,
        multiplierResolved: false,
        sourcePreserved: false,
      },
      debug: { eventId: event.eventId },
    });
  }

  // Gate on the multiplier activation time, not the ex/effective date.
  let activationAt = pair.activationAt;
  if (!activationAt) {
    const state = await currentMultiplierState(rule.sourceSymbol).catch(() => null);
    activationAt = state?.activationAt;
  }
  if (!activationAt) {
    return blocked('BLOCKED', 'Multiplier activation timestamp unavailable — refusing to execute inside an unknown safety window', {
      guards: {
        idempotent: true,
        threshold: false,
        eventType: true,
        activationSafe: false,
        multiplierResolved: true,
        sourcePreserved: false,
      },
    });
  }
  if (!safeAfter(activationAt)) {
    return blocked('WAITING', 'xStocks multiplier safety window still active', {
      guards: {
        idempotent: true,
        threshold: false,
        eventType: true,
        activationSafe: false,
        multiplierResolved: true,
        sourcePreserved: false,
      },
      debug: { activationAt },
    });
  }
  if (!(await multiplierIsLive(rule.sourceSymbol, pair.m1))) {
    return blocked('WAITING', 'Multiplier update is scheduled but not yet live', {
      guards: {
        idempotent: true,
        threshold: false,
        eventType: true,
        activationSafe: false,
        multiplierResolved: true,
        sourcePreserved: false,
      },
    });
  }

  const sourceMint = await solanaMintFor(rule.sourceSymbol);
  const bal = await rawTokenBalance(rule.wallet, sourceMint);
  if (bal.amount <= 0n) return blocked('WAITING', `No ${rule.sourceSymbol} position held`);

  // Attribution guard: Solana xStocks corporate actions change the multiplier,
  // not the raw Token-2022 balance. If the raw balance moved since the rule's
  // trusted baseline, the wallet bought/sold/transferred outside Overflow and we
  // cannot safely decide which raw units were present before this dividend.
  if (!rule.dividendRawBaseline) {
    return blocked('NEEDS_REVIEW', 'Dividend source baseline is missing. Recreate the rule after applying the latest migration.', {
      guards: {
        idempotent: true, threshold: false, eventType: true, activationSafe: true,
        multiplierResolved: true, sourcePreserved: false, sourceBaseline: false,
      },
    });
  }
  if (rule.dividendSourceDecimals != null && bal.decimals !== rule.dividendSourceDecimals) {
    return blocked('NEEDS_REVIEW', 'Source token decimals differ from the rule baseline — refusing to execute', {
      guards: {
        idempotent: true, threshold: false, eventType: true, activationSafe: true,
        multiplierResolved: true, sourcePreserved: false, sourceBaseline: false,
      },
      debug: { expectedDecimals: rule.dividendSourceDecimals, currentDecimals: bal.decimals },
    });
  }
  if (bal.amount.toString() !== rule.dividendRawBaseline) {
    return blocked('NEEDS_REVIEW', 'Raw xStock balance changed outside Overflow. Re-baseline the rule before attributing this dividend.', {
      guards: {
        idempotent: true, threshold: false, eventType: true, activationSafe: true,
        multiplierResolved: true, sourcePreserved: false, sourceBaseline: false,
      },
      debug: { expectedRaw: rule.dividendRawBaseline, currentRaw: bal.amount.toString() },
    });
  }

  const raw = dividendRawAtomic(bal.amount, pair.m0, pair.m1);
  if (raw <= 0n) {
    return blocked('WAITING', 'No dividend-created raw exposure', {
      debug: { m0: pair.m0, m1: pair.m1 },
    });
  }

  const preserved = sourceExposurePreserved({
    rawBefore: bal.amount,
    rawRemoved: raw,
    decimals: bal.decimals,
    multiplierBefore: pair.m0,
    multiplierAfter: pair.m1,
  });
  if (!preserved) {
    return blocked('BLOCKED', 'Preservation invariant failed — execution refused', {
      guards: {
        idempotent: true,
        threshold: false,
        eventType: true,
        activationSafe: true,
        multiplierResolved: true,
        sourcePreserved: false,
      },
    });
  }

  // The threshold is USD-denominated. Value only the newly-created economic
  // exposure, never the user's original source position.
  let sourcePriceUsd: Decimal;
  try {
    sourcePriceUsd = await assetPriceUsd(rule.sourceSymbol);
  } catch (e: any) {
    return blocked('BLOCKED', `Could not verify the $${rule.minExecutionUsd} execution threshold: ${e.message}`, {
      guards: {
        idempotent: true,
        threshold: false,
        eventType: true,
        activationSafe: true,
        multiplierResolved: true,
        sourcePreserved: true,
      },
    });
  }
  const dividendExposure = scaledExposure(raw, bal.decimals, pair.m1);
  const estimatedEarningsUsd = dividendExposure.mul(sourcePriceUsd);
  if (estimatedEarningsUsd.lt(rule.minExecutionUsd)) {
    return blocked('WAITING', `Dividend value $${estimatedEarningsUsd.toFixed(2)} is below your $${rule.minExecutionUsd} threshold`, {
      guards: {
        idempotent: true,
        threshold: false,
        eventType: true,
        activationSafe: true,
        multiplierResolved: true,
        sourcePreserved: true,
      },
      debug: {
        sourcePriceUsd: sourcePriceUsd.toFixed(8),
        dividendExposure: dividendExposure.toFixed(8),
      },
    });
  }

  const intent: ExecutionIntent = {
    id: randomUUID(),
    ruleId: rule.id,
    wallet: rule.wallet,
    sourceSymbol: rule.sourceSymbol,
    destinationSymbol: rule.destinationSymbol,
    sourceMint,
    destinationMint: rule.destinationMint,
    rawAmount: raw.toString(),
    sourceDecimals: bal.decimals,
    maxSlippageBps: rule.maxSlippageBps,
    reason: 'DIVIDEND',
    eventId: event.eventId,
    state: 'PREPARED',
    snapshot: {
      sourceRawBefore: bal.amount.toString(),
      multiplierBefore: pair.m0,
      multiplierAfter: pair.m1,
      takenAt: new Date().toISOString(),
    },
    metadata: {
      effectiveAt: event.effectiveAt,
      activationAt,
      matchedBy: pair.matchedBy,
      sourcePriceUsd: sourcePriceUsd.toFixed(8),
      estimatedEarningsUsd: estimatedEarningsUsd.toFixed(8),
    },
    createdAt: new Date().toISOString(),
  };
  await saveIntent(intent);

  return {
    ready: true,
    status: 'READY',
    intent,
    guards: {
      idempotent: true,
      threshold: true,
      eventType: true,
      activationSafe: true,
      multiplierResolved: true,
      sourcePreserved: true,
      sourceBaseline: true,
    },
  };
}

/* ------------------------- interest ------------------------- */

async function evaluateInterest(rule: Rule): Promise<EvaluationResult> {
  // If the Kamino withdrawal already landed but the swap did not, resume that
  // same server-side intent. Never withdraw a second time.
  const prior = await getLatestIntentForRule(rule.id);
  if (prior?.reason === 'INTEREST' && ['WITHDRAWN', 'SWAP_PREPARED'].includes(prior.state || '')) {
    return {
      ready: true,
      status: 'READY',
      intent: prior,
      reason: 'Previously withdrawn earnings are waiting to be routed; no second withdrawal will occur.',
      guards: { idempotent: true, threshold: true, sourcePreserved: true, unitsPlausible: true },
    };
  }

  const vault = rule.vaultAddress || process.env.KAMINO_USDC_VAULT;
  if (!vault) return blocked('BLOCKED', 'No Kamino vault configured');
  if (rule.principalFloorUsd == null) {
    return blocked('NEEDS_REVIEW', 'Confirm your principal floor before activating this rule');
  }

  const snap = await getKaminoVaultSnapshot(vault, rule.wallet);
  if (!rule.vaultSharesBaseline) {
    return blocked('NEEDS_REVIEW', 'This rule has no Kamino share baseline. Recreate it after applying the latest migration.', {
      guards: { idempotent: true, threshold: false, sourcePreserved: false, unitsPlausible: true },
    });
  }
  if (!new Decimal(snap.sharesAmount).eq(new Decimal(rule.vaultSharesBaseline))) {
    return blocked(
      'NEEDS_REVIEW',
      'Kamino share balance changed outside this rule. Principal may have been deposited or withdrawn; confirm a new principal floor before harvesting.',
      {
        guards: { idempotent: true, threshold: false, sourcePreserved: false, unitsPlausible: true },
        debug: { expectedShares: rule.vaultSharesBaseline, currentShares: snap.sharesAmount },
      }
    );
  }

  const buffer = rule.safetyBufferUsd != null
    ? new Decimal(rule.safetyBufferUsd)
    : defaultSafetyBufferUsd(rule.principalFloorUsd);
  const harvest = harvestableInterestUsd(
    snap.redeemableUsd,
    rule.principalFloorUsd,
    buffer.toFixed(18)
  );

  // Defense in depth against atomic-vs-human unit mistakes.
  const plausible = harvestPlausible(harvest, snap.redeemableUsd);
  if (!plausible.ok) {
    return blocked(
      'NEEDS_REVIEW',
      `Computed interest is ${plausible.fraction} of the position — unit check failed. Run npm run verify:kamino before signing.`,
      {
        guards: { idempotent: true, threshold: false, sourcePreserved: false, unitsPlausible: false },
        debug: snap as any,
      }
    );
  }

  if (harvest.lt(rule.minExecutionUsd)) {
    return blocked('WAITING', `Interest $${harvest.toFixed(2)} is below your $${rule.minExecutionUsd} threshold`, {
      guards: { idempotent: true, threshold: false, sourcePreserved: true, unitsPlausible: true },
      debug: snap as any,
    });
  }

  const sharesAmount = sharesForWithdrawal(harvest.toFixed(6), snap);
  if (sharesAmount.lte(0) || sharesAmount.gt(new Decimal(snap.sharesAmount))) {
    return blocked('BLOCKED', 'Withdrawal share calculation is invalid or exceeds the vault position');
  }

  const intent: ExecutionIntent = {
    id: randomUUID(),
    ruleId: rule.id,
    wallet: rule.wallet,
    sourceSymbol: 'USDC',
    destinationSymbol: rule.destinationSymbol,
    sourceMint: USDC_MINT,
    destinationMint: rule.destinationMint,
    rawAmount: harvest.mul(new Decimal(10).pow(snap.tokenDecimals)).floor().toFixed(0),
    sourceDecimals: snap.tokenDecimals,
    maxSlippageBps: rule.maxSlippageBps,
    reason: 'INTEREST',
    withdraw: {
      vaultAddress: vault,
      tokenAmount: harvest.toFixed(6),
      sharesAmount: sharesAmount.toFixed(12),
    },
    state: 'PREPARED',
    snapshot: {
      sourceRawBefore: snap.sharesAmount,
      redeemableUsd: snap.redeemableUsd,
      principalFloorUsd: String(rule.principalFloorUsd),
      takenAt: new Date().toISOString(),
    },
    metadata: {
      vaultAddress: vault,
      exchangeRate: snap.exchangeRate,
      derivation: snap.derivation,
      safetyBufferUsd: buffer.toFixed(6),
      harvestableUsd: harvest.toFixed(6),
      apy: snap.apy,
    },
    createdAt: new Date().toISOString(),
  };
  await saveIntent(intent);

  return {
    ready: true,
    status: 'READY',
    intent,
    guards: { idempotent: true, threshold: true, sourcePreserved: true, unitsPlausible: true },
  };
}
