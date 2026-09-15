import { NextRequest, NextResponse } from 'next/server';
import { connection, awaitConfirmation, txFromBase64, tokenDeltaFromTransaction, transactionMessageHash } from '@/lib/solana';
import { getKaminoVaultSnapshot } from '@/lib/kamino';
import { getIntent, updateIntent, updateRuleVaultSharesBaseline } from '@/lib/repository';
import type { ExecutionIntent } from '@/lib/types';

/**
 * Confirms the user-signed Kamino withdrawal and measures the USDC created by
 * that exact transaction. The moment the withdrawal lands we persist that fact
 * before doing any secondary RPC reads, so a later verifier failure can never
 * cause a second withdrawal on retry.
 */
export async function POST(req: NextRequest) {
  try {
    const { intentId, signedTransaction } = await req.json();
    if (!intentId || !signedTransaction) throw new Error('intentId and signedTransaction required');

    const intent = await getIntent(intentId);
    if (!intent) return NextResponse.json({ error: 'Intent not found' }, { status: 404 });
    if (intent.reason !== 'INTEREST' || !intent.withdraw) {
      return NextResponse.json({ error: 'Intent is not a Kamino interest withdrawal' }, { status: 400 });
    }

    const existing = (intent.metadata?.withdrawal as any) || null;
    if (existing?.completedAt) {
      return NextResponse.json({
        signature: existing.signature,
        confirmed: true,
        withdrawnRaw: String(existing.withdrawnRaw || '0'),
        status: intent.state,
        intent,
      });
    }

    const expectedMessageHash = String(existing?.preparedMessageHash || '');
    if (!expectedMessageHash) {
      return NextResponse.json({
        error: 'Prepared Kamino withdrawal binding is missing; prepare a fresh withdrawal before signing',
        status: 'BLOCKED',
      }, { status: 409 });
    }

    let signedMessageHash: string;
    try {
      signedMessageHash = transactionMessageHash(signedTransaction);
    } catch (e: any) {
      return NextResponse.json({ error: `Invalid signed Solana transaction: ${e.message}`, status: 'BLOCKED' }, { status: 400 });
    }
    if (signedMessageHash !== expectedMessageHash) {
      return NextResponse.json({
        error: 'Signed withdrawal message does not match the Kamino transaction prepared for this intent',
        status: 'BLOCKED',
      }, { status: 409 });
    }

    const c = connection();
    const tx = txFromBase64(signedTransaction);
    const signature = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const conf = await awaitConfirmation(signature);
    if (!conf.confirmed) {
      return NextResponse.json({
        error: `Withdrawal not confirmed: ${JSON.stringify(conf.error)}`,
        signature,
      }, { status: 502 });
    }

    const completedAt = new Date().toISOString();
    const exact = await tokenDeltaFromTransaction(signature, intent.wallet, intent.sourceMint).catch(() => null);
    const withdrawn = exact?.delta ?? 0n;

    // Persist landed state FIRST. Even if every RPC below fails, prepare-withdraw
    // will see completedAt and will never construct a second withdrawal.
    let next: ExecutionIntent = {
      ...intent,
      state: 'NEEDS_REVIEW',
      metadata: {
        ...intent.metadata,
        withdrawal: {
          ...(existing || {}),
          signature,
          completedAt,
          withdrawnRaw: withdrawn > 0n ? withdrawn.toString() : '0',
          txSourceBeforeRaw: exact?.before?.toString() ?? null,
          txSourceAfterRaw: exact?.after?.toString() ?? null,
        },
      },
    };
    await updateIntent(next);

    if (withdrawn <= 0n) {
      return NextResponse.json({
        error: 'Kamino withdrawal landed, but a positive USDC delta could not be verified from transaction metadata. Do not withdraw again.',
        status: 'NEEDS_REVIEW',
        signature,
        intent: next,
      }, { status: 409 });
    }

    let post;
    try {
      post = await getKaminoVaultSnapshot(intent.withdraw.vaultAddress, intent.wallet);
      await updateRuleVaultSharesBaseline(intent.ruleId, post.sharesAmount);
    } catch (e: any) {
      return NextResponse.json({
        error: `Withdrawal landed and ${withdrawn.toString()} raw USDC was verified, but the post-withdraw Kamino position could not be re-read: ${e.message}. Do not withdraw again.`,
        status: 'NEEDS_REVIEW',
        signature,
        withdrawnRaw: withdrawn.toString(),
        intent: next,
      }, { status: 409 });
    }

    next = {
      ...next,
      state: 'WITHDRAWN',
      metadata: {
        ...next.metadata,
        withdrawal: {
          ...(next.metadata.withdrawal as any),
          postWithdrawSharesAmount: post.sharesAmount,
          postWithdrawRedeemableUsd: post.redeemableUsd,
        },
      },
    };
    await updateIntent(next);

    return NextResponse.json({
      signature,
      confirmed: true,
      withdrawnRaw: withdrawn.toString(),
      intent: next,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
