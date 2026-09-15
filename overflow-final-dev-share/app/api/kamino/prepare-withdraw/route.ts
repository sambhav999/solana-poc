import { NextRequest, NextResponse } from 'next/server';
import Decimal from 'decimal.js';
import { buildKaminoWithdrawTx, getKaminoVaultSnapshot } from '@/lib/kamino';
import { getIntent, updateIntent } from '@/lib/repository';
import { transactionMessageHash } from '@/lib/solana';

/**
 * Step 1 of an interest execution.
 *
 * The server owns the withdrawal amount. If this intent already completed its
 * Kamino leg, return it as resumable instead of ever building a second withdrawal.
 */
export async function POST(req: NextRequest) {
  try {
    const { intentId } = await req.json();
    const intent = await getIntent(intentId);
    if (!intent) return NextResponse.json({ error: 'Intent not found' }, { status: 404 });
    if (intent.reason !== 'INTEREST' || !intent.withdraw) {
      return NextResponse.json({ error: 'Intent has no Kamino interest withdrawal step' }, { status: 400 });
    }
    if (intent.state === 'COMPLETED') {
      return NextResponse.json({ error: 'Intent already completed' }, { status: 409 });
    }

    const existing = (intent.metadata?.withdrawal as any) || null;
    if (existing?.completedAt) {
      return NextResponse.json({
        alreadyWithdrawn: true,
        withdrawnRaw: String(existing.withdrawnRaw || '0'),
        signature: existing.signature,
        status: intent.state,
        intent,
      });
    }

    const snap = await getKaminoVaultSnapshot(intent.withdraw.vaultAddress, intent.wallet);
    const requestedShares = new Decimal(intent.withdraw.sharesAmount);
    if (requestedShares.lte(0) || requestedShares.gt(new Decimal(snap.sharesAmount))) {
      return NextResponse.json({
        error: 'Withdrawal share amount is invalid or exceeds the current Kamino position',
        status: 'BLOCKED',
      }, { status: 409 });
    }

    // The share balance must still match the evaluation snapshot. This catches an
    // external deposit/withdrawal between evaluation and signature preparation.
    if (!new Decimal(snap.sharesAmount).eq(new Decimal(intent.snapshot.sourceRawBefore))) {
      return NextResponse.json({
        error: 'Kamino share balance changed since evaluation — re-check earnings before signing',
        status: 'NEEDS_REVIEW',
      }, { status: 409 });
    }

    const transaction = await buildKaminoWithdrawTx(
      intent.withdraw.vaultAddress,
      intent.wallet,
      intent.withdraw.sharesAmount
    );

    const preparedMessageHash = transactionMessageHash(transaction);

    const next = {
      ...intent,
      metadata: {
        ...intent.metadata,
        withdrawal: {
          ...(existing || {}),
          preparedAt: new Date().toISOString(),
          requestedTokenAmount: intent.withdraw.tokenAmount,
          sharesAmount: intent.withdraw.sharesAmount,
          preparedMessageHash,
        },
      },
    };
    await updateIntent(next);

    return NextResponse.json({
      transaction,
      tokenAmount: intent.withdraw.tokenAmount,
      sharesAmount: intent.withdraw.sharesAmount,
      snapshot: snap,
      intent: next,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
