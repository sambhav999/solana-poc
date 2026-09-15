/**
 * End-to-end simulation.
 *
 * Under test for real: the rule engine, every guard, the intent store, idempotency,
 * the two-step interest flow (prepare → confirm → swap), on-chain verification and
 * receipt construction.
 *
 * Simulated: the four external boundaries — Solana RPC, xStocks, Kamino SDK, Jupiter.
 * A mutable `chain` object lets a test move balances mid-flow the way a real swap does.
 *
 * This proves logic and wiring. It cannot prove the Kamino unit convention or the
 * live API response shapes; only verify:kamino, verify:xstocks and a mainnet dry run do.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const MRKX_MINT = 'MRKxMint1111111111111111111111111111111111';
const SPYX_MINT = 'XsoBhf2ufR8niG5K7uGFQCLmeW7L7KpfK9oD9Vj1n7E';
const WALLET = 'So1anaWa11etAddress11111111111111111111111';
const VAULT = 'KaminoUSDCVau1t1111111111111111111111111111';

const chain: any = {};

vi.mock('../lib/solana', async importOriginal => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    connection: vi.fn(() => ({
      sendRawTransaction: async () => 'SIG_WITHDRAW',
      getLatestBlockhash: async () => ({ blockhash: 'bh' })
    })),
    txFromBase64: vi.fn(() => ({ serialize: () => new Uint8Array([1]) })),
    rawTokenBalance: vi.fn(async (_o: string, mint: string) => {
      if (chain.rpcDown) throw new actual.RpcUnavailable('simulated outage');
      const b = chain.balances[mint];
      if (!b) return { amount: 0n, decimals: 6, ata: '', exists: false };
      return { ...b, ata: `ata-${mint}`, exists: true };
    }),
    tokenDeltaFromTransaction: vi.fn(async (signature: string, _owner: string, mint: string) => {
      if (signature === 'SIG_WITHDRAW') {
        return { delta: chain.withdrawDelta, before: 0n, after: chain.withdrawDelta };
      }
      if (mint === SPYX_MINT) {
        const d = chain.destinationSwapDelta ?? 4_210_000n;
        return { delta: d, before: 0n, after: d };
      }
      const spend = mint === MRKX_MINT ? 6_359_300n : chain.withdrawDelta;
      return { delta: -spend, before: spend, after: 0n };
    }),
    awaitConfirmation: vi.fn(async () => ({
      confirmed: chain.confirmed, error: chain.confirmed ? null : 'InstructionError', slot: 1
    })),
    confirmSignature: vi.fn(async () => ({ confirmed: chain.confirmed, error: null, slot: 1 })),
    transactionMessageHash: vi.fn((b64: string) => b64 === 'TAMPERED' ? 'different-message' : 'prepared-message')
  };
});

vi.mock('../lib/xstocks', async importOriginal => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    corporateActions: vi.fn(async () => chain.events),
    latestCashDividend: vi.fn(async (symbol: string) =>
      actual.normalizeCashDividends(chain.events, symbol)
        .sort((a: any, b: any) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0] || null),
    resolveMultiplierPair: vi.fn(async (_s: string, eventId: string) => {
      const i = chain.history.findIndex((h: any) => h.eventId === eventId);
      if (i < 1) return null;
      return {
        m0: String(chain.history[i - 1].multiplier),
        m1: String(chain.history[i].multiplier),
        activationAt: chain.history[i].activationAt,
        matchedBy: 'eventId', entry: chain.history[i]
      };
    }),
    assetPriceUsd: vi.fn(async () => new (require('decimal.js').default || require('decimal.js'))(chain.sourcePriceUsd)),
    multiplierIsLive: vi.fn(async (_s: string, expected: string) => Number(chain.multiplier) >= Number(expected)),
    currentMultiplier: vi.fn(async () => chain.multiplier),
    solanaMintFor: vi.fn(async () => MRKX_MINT)
  };
});

vi.mock('../lib/kamino', async importOriginal => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getKaminoVaultSnapshot: vi.fn(async () => ({ ...chain.kamino, apy: 0.064, derivation: 'simulated' })),
    buildKaminoWithdrawTx: vi.fn(async () => 'BASE64_WITHDRAW_TX')
  };
});

vi.mock('../lib/jupiter', () => ({
  jupiterOrder: vi.fn(async (args: any) => ({
    transaction: 'BASE64_UNSIGNED_TX', requestId: 'req-1',
    slippageBps: chain.jupiterSlippage, inAmount: args.amount, outAmount: '1234567'
  })),
  jupiterExecute: vi.fn(async () => ({ signature: 'SIG_' + Math.random().toString(36).slice(2, 10) }))
}));

import { evaluateRule } from '@/lib/engine';
import { insertRule, isEventProcessed, listReceipts, getIntent, listRules } from '@/lib/repository';
import { POST as prepareWithdraw } from '@/app/api/kamino/prepare-withdraw/route';
import { POST as confirmWithdraw } from '@/app/api/execution/confirm/route';
import { POST as prepareSwap } from '@/app/api/execution/prepare/route';
import { POST as executeSwap } from '@/app/api/jupiter/execute/route';
import type { Rule } from '@/lib/types';

const post = (body: any) => new Request('http://t/api', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
}) as any;

const dividendRule = (id: string): Rule => ({
  id, wallet: WALLET, kind: 'XSTOCK_DIVIDEND', sourceSymbol: 'MRKx',
  destinationSymbol: 'SPYx', destinationMint: SPYX_MINT, minExecutionUsd: 0,
  maxSlippageBps: 50, status: 'ACTIVE', baselineEventId: 'baseline-old',
  dividendRawBaseline: '1000000000', dividendSourceDecimals: 8,
  createdAt: new Date().toISOString()
});

const interestRule = (id: string): Rule => ({
  id, wallet: WALLET, kind: 'KAMINO_INTEREST', sourceSymbol: 'USDC',
  destinationSymbol: 'SPYx', destinationMint: SPYX_MINT, minExecutionUsd: 5,
  maxSlippageBps: 50, status: 'ACTIVE', principalFloorUsd: 10000,
  principalFloorSource: 'USER_CONFIRMED', safetyBufferUsd: 5, vaultAddress: VAULT,
  vaultSharesBaseline: '10000.000000',
  createdAt: new Date().toISOString()
});

beforeEach(() => {
  const effectiveAt = new Date(Date.now() - 60 * 60_000).toISOString();
  Object.assign(chain, {
    balances: { [MRKX_MINT]: { amount: 1_000_000_000n, decimals: 8 }, [SPYX_MINT]: { amount: 0n, decimals: 8 } },
    confirmed: true, rpcDown: false, multiplier: '1.0064', jupiterSlippage: 50,
    withdrawDelta: 13_900_000n, sourcePriceUsd: '88.50',
    kamino: { sharesAmount: '10000.000000', sharesDecimals: 6, tokenDecimals: 6, exchangeRate: '1.001892', redeemableUsd: '10018.920000' },
    events: [{ id: 'evt-div-1', symbol: 'MRKx', caType: 'CashDividend', effectiveDate: effectiveAt }],
    history: [
      { eventId: 'evt-prior', multiplier: '1', effectiveAt: new Date(Date.now() - 86_400_000 * 30).toISOString() },
      { eventId: 'evt-div-1', multiplier: '1.0064', effectiveAt, activationAt: effectiveAt }
    ]
  });
});

describe('E2E — dividend, full path', () => {
  it('isolates, routes, verifies on chain, and refuses a second run', async () => {
    const rule = dividendRule('r-div-1');
    await insertRule(rule);

    const evaluation = await evaluateRule(rule);
    expect(evaluation.status).toBe('READY');
    expect(evaluation.intent!.rawAmount).toBe('6359300');
    expect(evaluation.guards.sourcePreserved).toBe(true);

    const quoted = await (await prepareSwap(post({ intentId: evaluation.intent!.id }))).json();
    expect(quoted.routedRaw).toBe('6359300');
    expect(quoted.slippageBps).toBe(50);

    chain.balances[MRKX_MINT] = { amount: 1_000_000_000n - 6_359_300n, decimals: 8 };
    chain.balances[SPYX_MINT] = { amount: 4_210_000n, decimals: 8 };

    const done = await (await executeSwap(post({
      intentId: evaluation.intent!.id, signedTransaction: 'SIGNED', requestId: 'req-1'
    }))).json();

    expect(done.receipt.verification).toBe('VERIFIED_ON_CHAIN');
    expect(done.receipt.preserved).toBe(true);
    expect(done.receipt.exposureBefore).toBe('10.00000000');
    expect(Number(done.receipt.exposureAfter)).toBeGreaterThanOrEqual(10);

    expect(await isEventProcessed(rule.id, 'evt-div-1')).toBe(true);
    const storedRule = (await listRules(WALLET)).find(r => r.id === rule.id)!;
    expect(storedRule.dividendRawBaseline).toBe((1_000_000_000n - 6_359_300n).toString());
    expect(storedRule.baselineEventId).toBe('evt-div-1');
    const again = await evaluateRule(storedRule);
    expect(again.ready).toBe(false);
    expect(again.reason).toMatch(/already/i);

    expect((await listReceipts(WALLET))[0].signature).toBeTruthy();
  });
});

describe('E2E — interest, three-step path', () => {
  it('withdraws, measures the real delta, and routes only what landed', async () => {
    const rule = interestRule('r-int-1');
    await insertRule(rule);

    const evaluation = await evaluateRule(rule);
    expect(evaluation.status).toBe('READY');
    // 10018.92 redeemable − 10000 floor − 5 buffer = 13.92
    expect(evaluation.intent!.withdraw!.tokenAmount).toBe('13.920000');
    expect(evaluation.intent!.rawAmount).toBe('13920000');

    const built = await (await prepareWithdraw(post({ intentId: evaluation.intent!.id }))).json();
    expect(built.transaction).toBeTruthy();

    // the withdrawal actually produced 13.90, not the 13.92 quoted
    const confirmed = await (await confirmWithdraw(post({
      intentId: evaluation.intent!.id, signedTransaction: 'SIGNED_WITHDRAW'
    }))).json();
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.withdrawnRaw).toBe('13900000');
    expect((await getIntent(evaluation.intent!.id))!.state).toBe('WITHDRAWN');

    const quoted = await (await prepareSwap(post({
      intentId: evaluation.intent!.id, withdrawnRaw: confirmed.withdrawnRaw
    }))).json();
    expect(quoted.routedRaw).toBe('13900000'); // capped at what landed, never the estimate

    chain.kamino.redeemableUsd = '10005.000000';
    const done = await (await executeSwap(post({
      intentId: evaluation.intent!.id, signedTransaction: 'SIGNED', requestId: 'req-1'
    }))).json();
    expect(done.receipt.preserved).toBe(true);
    expect(done.receipt.verification).toBe('VERIFIED_ON_CHAIN');
  });

  it('never builds a second withdrawal once one has landed', async () => {
    const rule = interestRule('r-int-2');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    await prepareWithdraw(post({ intentId: evaluation.intent!.id }));
    await confirmWithdraw(post({ intentId: evaluation.intent!.id, signedTransaction: 'SIGNED_WITHDRAW' }));

    const res = await prepareWithdraw(post({ intentId: evaluation.intent!.id }));
    const body = await res.json();
    expect(body.alreadyWithdrawn).toBe(true);
    expect(body.transaction).toBeUndefined();   // no second withdrawal is ever constructed
    expect(body.withdrawnRaw).toBe('13900000');
  });

  it('refuses a signed Kamino transaction whose message differs from the prepared withdrawal', async () => {
    const rule = interestRule('r-int-bind');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    await prepareWithdraw(post({ intentId: evaluation.intent!.id }));
    const res = await confirmWithdraw(post({ intentId: evaluation.intent!.id, signedTransaction: 'TAMPERED' }));
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('BLOCKED');
  });

  it('refuses the swap when the withdrawal has not completed', async () => {
    const rule = interestRule('r-int-3');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    const res = await prepareSwap(post({ intentId: evaluation.intent!.id }));
    expect(res.status).toBe(409);
  });

  it('flags NEEDS_REVIEW when a landed withdrawal shows no positive delta', async () => {
    const rule = interestRule('r-int-4');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    await prepareWithdraw(post({ intentId: evaluation.intent!.id }));
    chain.withdrawDelta = 0n;
    const res = await confirmWithdraw(post({ intentId: evaluation.intent!.id, signedTransaction: 'SIGNED_WITHDRAW' }));
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('NEEDS_REVIEW');
  });
});

describe('E2E — guards that must refuse', () => {
  it('blocks the atomic-vs-dollar unit error instead of draining the vault', async () => {
    const rule = interestRule('r-units');
    await insertRule(rule);
    chain.kamino.redeemableUsd = '10018920000';
    const evaluation = await evaluateRule(rule);
    expect(evaluation.status).toBe('NEEDS_REVIEW');
    expect(evaluation.guards.unitsPlausible).toBe(false);
    expect(evaluation.intent).toBeUndefined();
  });

  it('blocks an unmatched corporate action rather than guessing a multiplier pair', async () => {
    const rule = dividendRule('r-unmatched');
    await insertRule(rule);
    chain.history = [{ eventId: 'other', multiplier: '1.02', effectiveAt: new Date().toISOString(), activationAt: new Date().toISOString() }];
    const evaluation = await evaluateRule(rule);
    expect(evaluation.status).toBe('BLOCKED');
  });

  it('waits while the multiplier is scheduled but not live', async () => {
    const rule = dividendRule('r-notlive');
    await insertRule(rule);
    chain.multiplier = '1';
    expect((await evaluateRule(rule)).status).toBe('WAITING');
  });

  it('waits inside the activation safety window', async () => {
    const rule = dividendRule('r-window');
    await insertRule(rule);
    const now = new Date().toISOString();
    chain.events = [{ id: 'evt-fresh', symbol: 'MRKx', caType: 'CashDividend', effectiveDate: now }];
    chain.history = [
      { eventId: 'evt-prior', multiplier: '1', effectiveAt: new Date(Date.now() - 86_400_000).toISOString() },
      { eventId: 'evt-fresh', multiplier: '1.0064', effectiveAt: now, activationAt: now }
    ];
    const evaluation = await evaluateRule(rule);
    expect(evaluation.status).toBe('WAITING');
    expect(evaluation.guards.activationSafe).toBe(false);
  });

  it('ignores splits — only cash dividends route', async () => {
    const rule = dividendRule('r-split');
    await insertRule(rule);
    chain.events = [{ id: 'evt-split', symbol: 'MRKx', caType: 'SPLF', effectiveDate: new Date(Date.now() - 3_600_000).toISOString() }];
    expect((await evaluateRule(rule)).ready).toBe(false);
  });

  it('refuses the swap if the source balance moved after the snapshot', async () => {
    const rule = dividendRule('r-drift');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    chain.balances[MRKX_MINT] = { amount: 500_000_000n, decimals: 8 };
    const res = await prepareSwap(post({ intentId: evaluation.intent!.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('NEEDS_REVIEW');
  });

  it('refuses dividend attribution when raw xStock changed since rule activation', async () => {
    const rule = dividendRule('r-baseline-drift');
    await insertRule(rule);
    // User bought more after the trusted baseline. Because raw xStock does not
    // change for the dividend itself, this must be treated as external mutation.
    chain.balances[MRKX_MINT] = { amount: 1_100_000_000n, decimals: 8 };
    const evaluation = await evaluateRule(rule);
    expect(evaluation.status).toBe('NEEDS_REVIEW');
    expect(evaluation.guards.sourceBaseline).toBe(false);
    expect(evaluation.reason).toMatch(/baseline|changed outside/i);
  });

  it('binds execution to the Jupiter requestId prepared for this intent', async () => {
    const rule = dividendRule('r-request-bind');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    await prepareSwap(post({ intentId: evaluation.intent!.id }));
    const res = await executeSwap(post({
      intentId: evaluation.intent!.id, signedTransaction: 'SIGNED', requestId: 'wrong-request'
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/requestId/i);
  });

  it('rejects a signed transaction whose message differs from the prepared Jupiter order', async () => {
    const rule = dividendRule('r-message-bind');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    await prepareSwap(post({ intentId: evaluation.intent!.id }));
    const res = await executeSwap(post({
      intentId: evaluation.intent!.id, signedTransaction: 'TAMPERED', requestId: 'req-1'
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/does not match/i);
  });

  it('refuses a quote above the rule slippage limit', async () => {
    const rule = dividendRule('r-slip');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    chain.jupiterSlippage = 300;
    const res = await prepareSwap(post({ intentId: evaluation.intent!.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/slippage/i);
  });

  it('surfaces an RPC outage instead of reporting a zero balance', async () => {
    const rule = dividendRule('r-rpc');
    await insertRule(rule);
    chain.rpcDown = true;
    await expect(evaluateRule(rule)).rejects.toThrow(/RPC unavailable/);
  });

  it('stays paused when the rule is paused', async () => {
    const rule = { ...dividendRule('r-paused'), status: 'PAUSED' as const };
    await insertRule(rule);
    expect((await evaluateRule(rule)).reason).toMatch(/paused/i);
  });

  it('waits when interest is below the threshold', async () => {
    const rule = interestRule('r-below');
    await insertRule(rule);
    chain.kamino.redeemableUsd = '10007.000000';
    const evaluation = await evaluateRule(rule);
    expect(evaluation.status).toBe('WAITING');
    expect(evaluation.reason).toMatch(/threshold/i);
  });
});

describe('E2E — failure recorded honestly', () => {
  it('writes a FAILED receipt and leaves the dividend routable when the tx never confirms', async () => {
    const rule = dividendRule('r-unconfirmed');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    await prepareSwap(post({ intentId: evaluation.intent!.id }));
    chain.confirmed = false;
    const done = await (await executeSwap(post({
      intentId: evaluation.intent!.id, signedTransaction: 'SIGNED', requestId: 'req-1'
    }))).json();
    expect(done.receipt.verification).toBe('FAILED');
    expect(done.receipt.preserved).toBe(false);
    expect(await isEventProcessed(rule.id, 'evt-div-1')).toBe(false);
  });

  it('writes preserved:false when exposure actually fell', async () => {
    const rule = dividendRule('r-notpreserved');
    await insertRule(rule);
    const evaluation = await evaluateRule(rule);
    await prepareSwap(post({ intentId: evaluation.intent!.id }));
    // simulate a swap that took far more than the isolated dividend
    chain.balances[MRKX_MINT] = { amount: 900_000_000n, decimals: 8 };
    const done = await (await executeSwap(post({
      intentId: evaluation.intent!.id, signedTransaction: 'SIGNED', requestId: 'req-1'
    }))).json();
    expect(done.receipt.preserved).toBe(false);
    expect(done.receipt.verification).toBe('FAILED');
  });
});
