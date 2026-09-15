import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { insertRule, listRules, setRuleStatus } from '@/lib/repository';
import { latestCashDividend, solanaMintFor } from '@/lib/xstocks';
import { defaultSafetyBufferUsd } from '@/lib/math';
import { getKaminoVaultSnapshot } from '@/lib/kamino';
import { rawTokenBalance } from '@/lib/solana';
import type { Rule } from '@/lib/types';
import Decimal from 'decimal.js';

const schema = z.object({
  wallet: z.string().min(32),
  kind: z.enum(['XSTOCK_DIVIDEND', 'KAMINO_INTEREST']),
  sourceSymbol: z.string().min(2),
  destinationSymbol: z.string().min(2),
  minExecutionUsd: z.number().nonnegative(),
  maxSlippageBps: z.number().int().min(1).max(500).optional(),
  principalFloorUsd: z.number().nonnegative().optional(),
  principalFloorSource: z.enum(['DEPOSITED', 'USER_CONFIRMED']).optional(),
  safetyBufferUsd: z.number().nonnegative().optional(),
  vaultAddress: z.string().optional()
});

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get('wallet');
  if (!wallet) return NextResponse.json({ error: 'wallet required' }, { status: 400 });
  return NextResponse.json({ rules: await listRules(wallet) });
}

export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());
    const destinationMint = await solanaMintFor(body.destinationSymbol);
    if (body.kind === 'KAMINO_INTEREST' && body.principalFloorUsd == null) {
      return NextResponse.json({ error: 'Confirm the principal floor for this position' }, { status: 400 });
    }

    let baselineEventId: string | null = null;
    let vaultSharesBaseline: string | undefined;
    let dividendRawBaseline: string | undefined;
    let dividendSourceDecimals: number | undefined;
    let vaultAddress = body.vaultAddress;

    if (body.kind === 'XSTOCK_DIVIDEND') {
      // Freeze the user's raw Token-2022 source balance when the rule is activated.
      // Corporate actions do not change raw Solana balances, so any later drift
      // means the user transferred/bought/sold outside Overflow and attribution is
      // no longer safe. The engine will pause as NEEDS_REVIEW instead of guessing.
      const sourceMint = await solanaMintFor(body.sourceSymbol);
      const sourceBalance = await rawTokenBalance(body.wallet, sourceMint);
      if (sourceBalance.amount <= 0n) {
        throw new Error(`No ${body.sourceSymbol} position found in this wallet`);
      }
      dividendRawBaseline = sourceBalance.amount.toString();
      dividendSourceDecimals = sourceBalance.decimals;
      baselineEventId = (await latestCashDividend(body.sourceSymbol))?.eventId || null;
    } else {
      vaultAddress = vaultAddress || process.env.KAMINO_USDC_VAULT;
      if (!vaultAddress) throw new Error('KAMINO_USDC_VAULT is not configured');
      const snap = await getKaminoVaultSnapshot(vaultAddress, body.wallet);
      vaultSharesBaseline = snap.sharesAmount;
      if (new Decimal(snap.redeemableUsd).plus('0.01').lt(new Decimal(body.principalFloorUsd || 0))) {
        throw new Error(`Principal floor ${body.principalFloorUsd} exceeds current Kamino redeemable value ${snap.redeemableUsd}`);
      }
    }

    const rule: Rule = {
      id: randomUUID(),
      ...body,
      destinationMint,
      vaultAddress,
      vaultSharesBaseline,
      dividendRawBaseline,
      dividendSourceDecimals,
      maxSlippageBps: body.maxSlippageBps ?? Number(process.env.DEFAULT_MAX_SLIPPAGE_BPS || 50),
      principalFloorSource: body.principalFloorSource ?? (body.kind === 'KAMINO_INTEREST' ? 'USER_CONFIRMED' : undefined),
      safetyBufferUsd: body.safetyBufferUsd ?? (body.principalFloorUsd != null
        ? Number(defaultSafetyBufferUsd(body.principalFloorUsd).toFixed(6))
        : undefined),
      status: 'ACTIVE',
      baselineEventId,
      createdAt: new Date().toISOString()
    };
    await insertRule(rule);
    return NextResponse.json({ rule });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, status } = await req.json();
    if (!id || !['ACTIVE', 'PAUSED'].includes(status)) throw new Error('id and status required');
    await setRuleStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
