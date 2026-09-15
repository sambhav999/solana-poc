import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { createRule, getRule, listRules, updateRule, deleteRule } from '../db/rules.js';
import { listReceipts, listReceiptsForRule } from '../db/receipts.js';
import { listSnapshots, getOpenSnapshotForRule } from '../db/snapshots.js';
import { listStranded } from '../db/stranded.js';
import { listDestinations, getAssetDetail, checkSourceRoutable, getAsset } from '../services/assets.js';
import { evaluateRule } from '../services/evaluate.js';
import { prepareExecution, submitExecution } from '../services/execute.js';
import { listReplayEvents, replayEvent } from '../services/replay.js';
import { sdkStatus } from '../adapters/kamino/vault.js';
import { getSlot, getSolBalanceLamports, getTokenBalance, getMintInfo, getAccountOwnerProgram, SYSTEM_PROGRAM, USDC_MINT } from '../adapters/solana/rpc.js';
import { refreshBaselines } from '../services/drift.js';
import { pollOnce } from '../poller/poll.js';
import { limiterConfig } from '../adapters/jupiter/client.js';
import {
  prepareDeposit, submitDeposit,
  submitHarvestWithdrawal,
  preparePrincipalWithdrawal, submitPrincipalWithdrawal,
  pendingSwapFunds,
} from '../services/kaminoFlows.js';

export const router = Router();

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`[${req.method} ${req.path}]`, err);
  res.status(500).json({ error: err.message });
});

const requireWallet = (req, res) => {
  const wallet = req.query.wallet || req.body?.wallet;
  if (!wallet) { res.status(400).json({ error: 'wallet is required' }); return null; }
  return String(wallet);
};

router.get('/health', asyncRoute(async (_req, res) => {
  const [slot, kamino] = await Promise.all([getSlot().catch(() => null), sdkStatus()]);
  res.json({
    ok: true,
    slot,
    network: process.env.NETWORK || 'mainnet-beta',
    rpcConfigured: Boolean(process.env.SOLANA_RPC_URL),
    jupiterKeyConfigured: Boolean(process.env.JUPITER_API_KEY),
    jupiterThrottle: limiterConfig(),
    kamino,
    // Surfaced so the UI can prefill rather than asking a user to paste a vault
    // address. A rule may still override it per-rule.
    defaultKaminoVault: process.env.KAMINO_USDC_VAULT || null,
    mode: 'LIVE',
  });
}));

/* ---------------------------------------------------------------- assets -- */

router.get('/assets/destinations', asyncRoute(async (_req, res) => {
  res.json({ destinations: await listDestinations() });
}));

router.get('/assets/:symbol', asyncRoute(async (req, res) => {
  const detail = await getAssetDetail(req.params.symbol);
  if (!detail) return res.status(404).json({ error: 'unknown asset' });
  res.json(detail);
}));

router.get('/assets/:symbol/routable', asyncRoute(async (req, res) => {
  res.json(await checkSourceRoutable(req.params.symbol));
}));

/* ----------------------------------------------------------------- rules -- */

router.get('/rules', asyncRoute(async (req, res) => {
  const wallet = requireWallet(req, res); if (!wallet) return;
  const rules = listRules(wallet);
  const withState = await Promise.all(rules.map(async (rule) => ({
    ...rule,
    evaluation: await evaluateRule(rule).catch((e) => ({ status: 'BLOCKED', reason: e.message, guards: {} })),
    openSnapshot: getOpenSnapshotForRule(rule.id),
  })));
  res.json({ rules: withState });
}));

router.post('/rules', asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.wallet) return res.status(400).json({ error: 'wallet is required' });
  if (!b.sourceType || !b.destinationMint) return res.status(400).json({ error: 'sourceType and destinationMint are required' });

  // A source that cannot be routed can never execute, so it is refused at
  // creation -- but only on a CONFIRMED lack of route. An unverified check
  // (rate limit, upstream fault) is not a verdict and must not block anything.
  if (b.sourceType === 'XSTOCK_DIVIDEND') {
    const routable = await checkSourceRoutable(b.sourceSymbol ?? b.sourceId);
    if (!routable.ok) return res.status(400).json({ error: routable.detail ?? routable.reason, code: routable.reason });
  }
  /*
   * Destination mints are resolved SERVER-SIDE from the symbol. A browser-supplied
   * mint would let anything that can reach this endpoint point a rule's earnings
   * at an arbitrary token.
   */
  const destination = await getAsset(b.destinationSymbol);
  if (!destination) return res.status(400).json({ error: `unknown destination ${b.destinationSymbol}` });
  if (b.destinationMint && b.destinationMint !== destination.mint) {
    return res.status(400).json({
      error: `destinationMint does not match the server-resolved mint for ${b.destinationSymbol}`,
      code: 'DESTINATION_MINT_MISMATCH',
    });
  }
  // Same for the source: never trust a mint from the client.
  let resolvedSourceMint = null;
  if (b.sourceType === 'XSTOCK_DIVIDEND') {
    const sourceAsset = await getAsset(b.sourceSymbol ?? b.sourceId);
    if (!sourceAsset) return res.status(400).json({ error: `unknown source ${b.sourceSymbol ?? b.sourceId}` });
    resolvedSourceMint = sourceAsset.mint;
  } else {
    resolvedSourceMint = USDC_MINT;
  }

  const rule = createRule({
    wallet: b.wallet,
    sourceType: b.sourceType,
    sourceId: b.sourceId,
    sourceMint: resolvedSourceMint,
    sourceSymbol: b.sourceSymbol ?? null,
    sourceDecimals: b.sourceDecimals ?? 8,
    earningsType: b.sourceType === 'XSTOCK_DIVIDEND' ? 'DIVIDEND' : 'INTEREST',
    destinationMint: destination.mint,
    destinationSymbol: b.destinationSymbol,
    destinationDecimals: destination.decimals ?? 8,
    minExecutionUsdAtomic: b.minExecutionUsdAtomic ?? '5000000',
    maxSlippageBps: b.maxSlippageBps ?? 50,
    maxPriceImpactBps: b.maxPriceImpactBps ?? 100,
    allowOvernight: Boolean(b.allowOvernight),
    principalFloorAtomic: b.principalFloorAtomic ?? null,
    principalFloorSource: b.principalFloorAtomic ? (b.principalFloorSource ?? 'USER_CONFIRMED') : null,
    safetyBufferAtomic: b.safetyBufferAtomic ?? null,
    kaminoVault: b.kaminoVault ?? process.env.KAMINO_USDC_VAULT ?? null,
    kaminoShareMint: b.kaminoShareMint ?? null,
  });
  // Record what the position looks like now, so later drift is detectable.
  const baselined = await refreshBaselines(rule).catch(() => rule);
  res.status(201).json({ rule: baselined });
}));

/**
 * Reconfirm the baseline after an external change.
 *
 * A paused rule stays paused until the user accepts the position as it now is --
 * Overflow will not silently resume against a position it no longer understands.
 */
router.post('/rules/:id/reconfirm-baseline', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const refreshed = await refreshBaselines(rule);
  const resumed = updateRule(refreshed.id, { status: 'ACTIVE', pauseReason: null });
  res.json({ rule: resumed });
}));

router.get('/rules/:id', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  res.json({
    rule,
    evaluation: await evaluateRule(rule),
    snapshots: listSnapshots(rule.id),
    receipts: listReceiptsForRule(rule.id),
    stranded: listStranded(rule.id),
  });
}));

router.patch('/rules/:id', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  res.json({ rule: updateRule(req.params.id, req.body || {}) });
}));

router.delete('/rules/:id', asyncRoute(async (req, res) => {
  res.json({ deleted: deleteRule(req.params.id) });
}));

router.get('/rules/:id/evaluate', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  res.json(await evaluateRule(rule));
}));

/* ------------------------------------------------------------- execution -- */

router.post('/rules/:id/prepare', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const prepared = await prepareExecution(rule);
  if (!prepared.ok) return res.status(409).json(prepared);
  res.json(prepared);
}));

router.post('/rules/:id/submit', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const { signedTransaction, requestId, executionKey, context, intentId } = req.body || {};
  if (!signedTransaction || !requestId || !executionKey) {
    return res.status(400).json({ error: 'signedTransaction, requestId and executionKey are required' });
  }
  // intentId is what binds the signed transaction to what the server authorised.
  const result = await submitExecution({
    rule, signedTransactionBase64: signedTransaction, requestId, executionKey, context, intentId,
  });
  res.status(result.ok ? 200 : 409).json(result);
}));

/* --------------------------------------------------- kamino: deposit -- */

/**
 * Two calls, one signature in between:
 *   POST /deposit          -> unsigned transaction
 *   POST /deposit/submit   -> broadcast, confirm, floor += confirmed amount
 * The floor moves only in the second call, and only on a confirmed signature.
 */
router.post('/rules/:id/deposit', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const { usdcAtomic } = req.body || {};
  if (!usdcAtomic) return res.status(400).json({ error: 'usdcAtomic is required' });
  const prepared = await prepareDeposit({ rule, usdcAtomic });
  res.status(prepared.ok ? 200 : 409).json(prepared);
}));

router.post('/rules/:id/deposit/submit', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const { signedTransaction, context } = req.body || {};
  if (!signedTransaction || !context) return res.status(400).json({ error: 'signedTransaction and context are required' });
  const result = await submitDeposit({ rule, signedTransaction, context });
  res.status(result.ok ? 200 : 409).json(result);
}));

/* ------------------------------------------ kamino: harvest withdrawal leg -- */

/**
 * Step 1 of a harvest. POST /prepare returns stage WITHDRAW with the Kamino
 * transaction; this confirms it and records the USDC as awaiting its swap.
 */
router.post('/rules/:id/harvest/withdraw/submit', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const { signedTransaction, context } = req.body || {};
  if (!signedTransaction || !context) return res.status(400).json({ error: 'signedTransaction and context are required' });
  const result = await submitHarvestWithdrawal({ rule, signedTransaction, context });
  res.status(result.ok ? 200 : 409).json(result);
}));

/* ------------------------------------------- kamino: principal withdrawal -- */

/**
 * Returns the withdrawal plan alongside the transaction, including any
 * shortfall, so an impaired position can never be presented as a full return.
 */
router.post('/rules/:id/withdraw-principal', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const prepared = await preparePrincipalWithdrawal({ rule, requestedAtomic: req.body?.requestedAtomic });
  res.status(prepared.ok ? 200 : 409).json(prepared);
}));

router.post('/rules/:id/withdraw-principal/submit', asyncRoute(async (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  const { signedTransaction, context } = req.body || {};
  if (!signedTransaction || !context) return res.status(400).json({ error: 'signedTransaction and context are required' });
  const result = await submitPrincipalWithdrawal({ rule, signedTransaction, context });
  res.status(result.ok ? 200 : 409).json(result);
}));

/** USDC out of the vault but not yet swapped. */
router.get('/rules/:id/pending-funds', asyncRoute(async (req, res) => {
  res.json(pendingSwapFunds(req.params.id));
}));

/* -------------------------------------------------------------- receipts -- */

router.get('/receipts', asyncRoute(async (req, res) => {
  const wallet = requireWallet(req, res); if (!wallet) return;
  res.json({ receipts: listReceipts(wallet) });
}));

/* ---------------------------------------------------------------- replay -- */

router.get('/replay/:symbol/events', asyncRoute(async (req, res) => {
  res.json({ symbol: req.params.symbol, events: await listReplayEvents(req.params.symbol) });
}));

router.post('/replay/:symbol', asyncRoute(async (req, res) => {
  const { corporateActionId, rawBalanceAtomic, tokenDecimals } = req.body || {};
  if (!corporateActionId || !rawBalanceAtomic) {
    return res.status(400).json({ error: 'corporateActionId and rawBalanceAtomic are required' });
  }
  res.json(await replayEvent({
    symbol: req.params.symbol, corporateActionId, rawBalanceAtomic, tokenDecimals: tokenDecimals ?? 8,
  }));
}));

/* ---------------------------------------------------------------- wallet -- */

router.get('/wallet/:address/overview', asyncRoute(async (req, res) => {
  const owner = req.params.address;
  // A failed balance read must NOT be reported as a zero balance: "no SOL" and
  // "could not read" lead to opposite conclusions.
  const [balance, account, slot] = await Promise.all([
    getSolBalanceLamports(owner).then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, error: e.message })),
    getAccountOwnerProgram(owner).catch(() => null),
    getSlot().catch(() => null),
  ]);
  res.json({
    address: owner,
    solLamports: balance.ok ? balance.v.toString() : null,
    sol: balance.ok ? Number(balance.v) / 1e9 : null,
    balanceError: balance.ok ? null : balance.error,
    ownerProgram: account?.owner ?? null,
    canPayFees: account ? account.owner === SYSTEM_PROGRAM : true,
    slot,
  });
}));

router.get('/wallet/:address/token/:mint', asyncRoute(async (req, res) => {
  const [balance, mint] = await Promise.all([
    getTokenBalance({ owner: req.params.address, mint: req.params.mint }),
    getMintInfo(req.params.mint).catch(() => null),
  ]);
  res.json({ balance, mint });
}));

/* ---------------------------------------------------------------- poller -- */

router.post('/poll', asyncRoute(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) return res.status(401).json({ error: 'bad cron secret' });
  res.json(await pollOnce());
}));
