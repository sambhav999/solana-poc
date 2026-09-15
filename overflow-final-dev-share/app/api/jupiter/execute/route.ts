import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { jupiterExecute } from '@/lib/jupiter';
import {
  getIntent,
  getReceiptByIntent,
  insertReceipt,
  markEventProcessed,
  updateIntent,
  updateRuleDividendBaseline,
} from '@/lib/repository';
import { rawTokenBalance, transactionMessageHash } from '@/lib/solana';
import { verifyExecution } from '@/lib/verify';
import type { Receipt } from '@/lib/types';

/** Submit the exact signed Jupiter order prepared for this intent, then write a retry-safe proof receipt. */
export async function POST(req: NextRequest) {
  try {
    const { intentId, signedTransaction, requestId } = await req.json();
    const intent = await getIntent(intentId);
    if (!intent) return NextResponse.json({ error: 'Intent not found' }, { status: 404 });

    const priorReceipt = await getReceiptByIntent(intent.id);
    if (priorReceipt) {
      return NextResponse.json({ signature: priorReceipt.signature, receipt: priorReceipt, alreadyCompleted: true });
    }
    if (intent.state !== 'SWAP_PREPARED') {
      return NextResponse.json({ error: `Intent is ${intent.state}; it cannot be submitted again`, status: 'BLOCKED' }, { status: 409 });
    }
    if (!signedTransaction) {
      return NextResponse.json({ error: 'signedTransaction required' }, { status: 400 });
    }

    const prepared = intent.metadata?.jupiter as any;
    const expectedRequestId = String(prepared?.requestId || '');
    const expectedMessageHash = String(prepared?.preparedMessageHash || '');
    if (!expectedRequestId || !expectedMessageHash) {
      return NextResponse.json({ error: 'Prepared Jupiter order binding is missing; prepare a fresh swap', status: 'BLOCKED' }, { status: 409 });
    }
    if (requestId && String(requestId) !== expectedRequestId) {
      return NextResponse.json({ error: 'Jupiter requestId does not match this execution intent', status: 'BLOCKED' }, { status: 409 });
    }

    let signedMessageHash: string;
    try {
      signedMessageHash = transactionMessageHash(signedTransaction);
    } catch (e: any) {
      return NextResponse.json({ error: `Invalid signed Solana transaction: ${e.message}`, status: 'BLOCKED' }, { status: 400 });
    }
    if (signedMessageHash !== expectedMessageHash) {
      return NextResponse.json({ error: 'Signed transaction message does not match the Jupiter order prepared for this intent', status: 'BLOCKED' }, { status: 409 });
    }

    // Use the server-persisted requestId. Never trust a client-supplied replacement.
    const result = await jupiterExecute(signedTransaction, expectedRequestId);
    const signature = result.signature || result.txid || result.transactionSignature || '';
    if (!signature) return NextResponse.json({ error: 'Swap did not return a signature; no receipt written' }, { status: 502 });

    // Money may already have moved. Persist that fact BEFORE any post-settlement
    // RPC/API verification. If verification or receipt persistence later fails,
    // this intent cannot be submitted a second time by retrying the endpoint.
    const landedIntent = {
      ...intent,
      state: 'NEEDS_REVIEW' as const,
      metadata: {
        ...intent.metadata,
        swapSignature: signature,
        swapSubmittedAt: new Date().toISOString(),
        jupiterExecuteStatus: result.status ?? null,
        jupiterExecuteCode: result.code ?? null,
        totalInputAmount: result.totalInputAmount ?? null,
        totalOutputAmount: result.totalOutputAmount ?? null,
      },
    };
    await updateIntent(landedIntent);

    // Dividend extraction is deliberately fail-closed. Once Jupiter returns a
    // signature for this event, consume the event before verification so an RPC
    // outage or failed receipt write can never cause a second source extraction.
    if (intent.reason === 'DIVIDEND' && intent.eventId) {
      await markEventProcessed({
        ruleId: intent.ruleId,
        eventId: intent.eventId,
        signature,
        createdAt: new Date().toISOString(),
      });
    }

    let verified: Omit<Receipt, 'id' | 'wallet' | 'ruleId' | 'intentId' | 'title' | 'kind' | 'createdAt'>;
    try {
      verified = await verifyExecution(landedIntent, signature);
    } catch (e: any) {
      verified = {
        signature,
        sourceBefore: intent.snapshot.sourceRawBefore,
        sourceAfter: 'unknown',
        earningsRouted: String(intent.metadata?.routedRaw || intent.rawAmount),
        destinationReceived: 'unknown',
        exposureBefore: intent.snapshot.principalFloorUsd || intent.snapshot.multiplierBefore || 'unknown',
        exposureAfter: 'unknown',
        preserved: false,
        verification: 'UNVERIFIED',
        verificationNote: `Jupiter returned a transaction signature, but post-settlement verification could not complete: ${e.message}. Do not execute this intent again.`,
      };
    }

    const receipt: Receipt = {
      id: randomUUID(), wallet: intent.wallet, ruleId: intent.ruleId, intentId: intent.id,
      kind: intent.reason === 'DIVIDEND' ? 'XSTOCK_DIVIDEND' : 'KAMINO_INTEREST',
      title: `${intent.sourceSymbol} ${intent.reason === 'DIVIDEND' ? 'dividend' : 'interest'} → ${intent.destinationSymbol}`,
      createdAt: new Date().toISOString(), ...verified,
    };
    const storedReceipt = await insertReceipt(receipt);

    // A future dividend can only use a fresh trusted baseline. Refresh it only
    // after the current execution has been positively verified from on-chain state.
    if (intent.reason === 'DIVIDEND' && intent.eventId && verified.verification === 'VERIFIED_ON_CHAIN') {
      const after = await rawTokenBalance(intent.wallet, intent.sourceMint);
      await updateRuleDividendBaseline(intent.ruleId, after.amount.toString(), after.decimals, intent.eventId);
    }

    await updateIntent({
      ...landedIntent,
      state: verified.verification === 'VERIFIED_ON_CHAIN' ? 'COMPLETED' : 'NEEDS_REVIEW',
      metadata: {
        ...landedIntent.metadata,
        completedAt: new Date().toISOString(),
        verification: verified.verification,
      },
    });

    return NextResponse.json({ signature, receipt: storedReceipt });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
