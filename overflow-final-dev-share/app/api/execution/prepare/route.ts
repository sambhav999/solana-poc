import { NextRequest, NextResponse } from 'next/server';
import { getIntent, updateIntent } from '@/lib/repository';
import { jupiterOrder } from '@/lib/jupiter';
import { rawTokenBalance, transactionMessageHash } from '@/lib/solana';

/**
 * Prepare the Jupiter leg from server-side intent state only.
 * Interest routing uses the exact USDC delta verified from the Kamino withdrawal
 * transaction; the browser cannot increase it by supplying its own amount.
 */
export async function POST(req: NextRequest) {
  try {
    const { intentId } = await req.json();
    const intent = await getIntent(intentId);
    if (!intent) return NextResponse.json({ error: 'Intent not found' }, { status: 404 });
    if (intent.state === 'COMPLETED') {
      return NextResponse.json({ error: 'Intent already completed' }, { status: 409 });
    }

    let amount = BigInt(intent.rawAmount);

    if (intent.reason === 'INTEREST') {
      const withdrawal = intent.metadata?.withdrawal as any;
      if (!withdrawal?.completedAt || intent.state !== 'WITHDRAWN') {
        return NextResponse.json({ error: 'Kamino withdrawal must be confirmed before the swap', status: 'BLOCKED' }, { status: 409 });
      }
      const observed = BigInt(String(withdrawal.withdrawnRaw || '0'));
      if (observed <= 0n) {
        return NextResponse.json({ error: 'No verified withdrawn USDC available to route', status: 'NEEDS_REVIEW' }, { status: 409 });
      }
      // Never route more than the isolated earnings even if the withdrawal delta is larger.
      amount = observed < amount ? observed : amount;
    } else {
      // Snapshot drift guard immediately before quote construction. This is in
      // addition to the persistent rule baseline checked during evaluation.
      const now = await rawTokenBalance(intent.wallet, intent.sourceMint);
      if (now.amount.toString() !== intent.snapshot.sourceRawBefore) {
        return NextResponse.json({
          error: 'Source balance changed since evaluation — re-check earnings before executing',
          status: 'NEEDS_REVIEW',
        }, { status: 409 });
      }
    }

    const order = await jupiterOrder({
      inputMint: intent.sourceMint,
      outputMint: intent.destinationMint,
      amount: amount.toString(),
      taker: intent.wallet,
      slippageBps: intent.maxSlippageBps,
    });

    const quotedSlippage = Number(order.slippageBps ?? order.slippageBpsUsed ?? intent.maxSlippageBps);
    if (Number.isFinite(quotedSlippage) && quotedSlippage > intent.maxSlippageBps) {
      return NextResponse.json({
        error: `Quoted slippage ${quotedSlippage}bps exceeds your ${intent.maxSlippageBps}bps limit`,
        status: 'BLOCKED',
      }, { status: 409 });
    }

    const unsignedTransaction = order.transaction || order.swapTransaction;
    if (!unsignedTransaction) {
      return NextResponse.json({
        error: order.errorMessage || 'No Jupiter route available for this pair and size',
        code: order.errorCode,
        router: order.router,
        status: 'BLOCKED',
      }, { status: 409 });
    }
    if (!order.requestId) {
      return NextResponse.json({ error: 'Jupiter order returned no requestId; refusing unbound execution', status: 'BLOCKED' }, { status: 502 });
    }

    // Bind the future /execute call to exactly this order and exactly this message.
    // A client cannot swap in another Jupiter requestId or another transaction.
    const preparedMessageHash = transactionMessageHash(unsignedTransaction);
    const next = {
      ...intent,
      state: 'SWAP_PREPARED' as const,
      metadata: {
        ...intent.metadata,
        routedRaw: amount.toString(),
        swapPreparedAt: new Date().toISOString(),
        jupiter: {
          requestId: String(order.requestId),
          preparedMessageHash,
          lastValidBlockHeight: order.lastValidBlockHeight ?? null,
          expireAt: order.expireAt ?? null,
          router: order.router ?? null,
          mode: order.mode ?? null,
          expectedOutRaw: order.outAmount == null ? null : String(order.outAmount),
          quotedSlippageBps: quotedSlippage,
        },
      },
    };
    await updateIntent(next);

    return NextResponse.json({ order, routedRaw: amount.toString(), slippageBps: quotedSlippage, intent: next });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
