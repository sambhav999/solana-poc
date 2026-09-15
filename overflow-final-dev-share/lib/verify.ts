import Decimal from 'decimal.js';
import type { ExecutionIntent, Receipt } from './types';
import { rawTokenBalance, awaitConfirmation, tokenDeltaFromTransaction } from './solana';
import { currentMultiplier } from './xstocks';
import { getKaminoVaultSnapshot } from './kamino';
import { observedExposurePreserved } from './math';

type ProofState = { exact: boolean; available: boolean; actual: bigint | null; expected: bigint };

async function exactSpendProof(intent: ExecutionIntent, signature: string, routedRaw: string): Promise<ProofState> {
  const expected = -BigInt(routedRaw);
  const observed = await tokenDeltaFromTransaction(signature, intent.wallet, intent.sourceMint).catch(() => null);
  if (!observed) return { exact: false, available: false, actual: null, expected };
  return { exact: observed.delta === expected, available: true, actual: observed.delta, expected };
}

/** Post-transaction proof. Receipt fields are derived from chain/RPC state. */
export async function verifyExecution(
  intent: ExecutionIntent,
  signature: string
): Promise<Omit<Receipt, 'id' | 'wallet' | 'ruleId' | 'intentId' | 'title' | 'kind' | 'createdAt'>> {
  const conf = await awaitConfirmation(signature);
  if (!conf.confirmed) {
    return {
      signature,
      sourceBefore: intent.snapshot.sourceRawBefore,
      sourceAfter: 'unknown',
      earningsRouted: String(intent.metadata?.routedRaw || intent.rawAmount),
      destinationReceived: 'unknown',
      exposureBefore: 'unknown',
      exposureAfter: 'unknown',
      preserved: false,
      verification: 'FAILED',
      verificationNote: `Transaction not confirmed: ${JSON.stringify(conf.error)}`,
    };
  }

  const routedRaw = String(intent.metadata?.routedRaw || intent.rawAmount);

  // Prove both legs from THIS transaction's metadata. A receipt is only
  // VERIFIED_ON_CHAIN if the source spend equals the server-authorized amount
  // and the destination token actually increased in the same transaction.
  const sourceSpend = await exactSpendProof(intent, signature, routedRaw);
  const destDelta = await tokenDeltaFromTransaction(signature, intent.wallet, intent.destinationMint).catch(() => null);
  const receivedRaw = destDelta && destDelta.delta > 0n ? destDelta.delta.toString() : 'unknown';
  const destinationProven = receivedRaw !== 'unknown';

  if (intent.reason === 'DIVIDEND') {
    const after = await rawTokenBalance(intent.wallet, intent.sourceMint);
    let multiplierProven = true;
    let m1: string;
    try {
      m1 = await currentMultiplier(intent.sourceSymbol);
    } catch {
      multiplierProven = false;
      m1 = intent.snapshot.multiplierAfter || '1';
    }
    const check = observedExposurePreserved({
      rawBefore: BigInt(intent.snapshot.sourceRawBefore),
      rawAfter: after.amount,
      decimals: after.decimals,
      multiplierBefore: intent.snapshot.multiplierBefore || '1',
      multiplierAfter: m1,
    });

    const proofMismatch = sourceSpend.available && !sourceSpend.exact;
    const verified = check.preserved && sourceSpend.exact && destinationProven && multiplierProven;
    const verification = !check.preserved || proofMismatch
      ? 'FAILED'
      : verified
        ? 'VERIFIED_ON_CHAIN'
        : 'UNVERIFIED';

    let note: string;
    if (!check.preserved) {
      note = `Exposure fell from ${check.exposureBefore} to ${check.exposureAfter}; do not reuse this rule until reviewed.`;
    } else if (proofMismatch) {
      note = `Source-token delta ${sourceSpend.actual?.toString()} did not equal the authorized spend ${sourceSpend.expected.toString()}.`;
    } else if (!multiplierProven) {
      note = 'Source token state is available, but the live xStocks multiplier could not be re-read after settlement; receipt remains unverified.';
    } else if (!sourceSpend.available) {
      note = 'Source exposure is preserved, but the exact source-token spend could not be proven from transaction metadata.';
    } else if (!destinationProven) {
      note = 'Source exposure and spend are correct, but the destination token delta could not be proven from transaction metadata.';
    } else {
      note = `Pre-dividend exposure ${check.exposureBefore} ${intent.sourceSymbol} remains covered; exact source spend and destination receipt were proven from this transaction.`;
    }

    return {
      signature,
      sourceBefore: `${intent.snapshot.sourceRawBefore} raw`,
      sourceAfter: `${after.amount.toString()} raw`,
      earningsRouted: `${routedRaw} raw ${intent.sourceSymbol}`,
      destinationReceived: destinationProven ? `${receivedRaw} raw ${intent.destinationSymbol}` : 'unknown',
      exposureBefore: check.exposureBefore,
      exposureAfter: check.exposureAfter,
      preserved: check.preserved,
      verification,
      verificationNote: note,
    };
  }

  const vaultAddress = intent.withdraw?.vaultAddress;
  const floor = new Decimal(intent.snapshot.principalFloorUsd || 0);
  if (!vaultAddress) {
    return {
      signature, sourceBefore: 'unknown', sourceAfter: 'unknown',
      earningsRouted: routedRaw, destinationReceived: receivedRaw,
      exposureBefore: floor.toFixed(2), exposureAfter: 'unknown',
      preserved: false, verification: 'UNVERIFIED', verificationNote: 'No Kamino vault recorded on intent',
    };
  }

  const snap = await getKaminoVaultSnapshot(vaultAddress, intent.wallet);
  const remaining = new Decimal(snap.redeemableUsd);
  const preserved = remaining.gte(floor);
  const withdrawal = intent.metadata?.withdrawal as any;
  const verifiedWithdrawnRaw = String(withdrawal?.withdrawnRaw || 'unknown');
  const proofMismatch = sourceSpend.available && !sourceSpend.exact;
  const fullyVerified = preserved && sourceSpend.exact && destinationProven;
  const verification = !preserved || proofMismatch
    ? 'FAILED'
    : fullyVerified
      ? 'VERIFIED_ON_CHAIN'
      : 'UNVERIFIED';

  let note: string;
  if (!preserved) {
    note = `Position fell below the ${floor.toFixed(2)} USDC floor — principal may have been spent.`;
  } else if (proofMismatch) {
    note = `Principal floor remains covered, but swap USDC delta ${sourceSpend.actual?.toString()} did not equal the authorized spend ${sourceSpend.expected.toString()}.`;
  } else if (!sourceSpend.available) {
    note = 'Principal floor remains covered, but the exact swap input could not be proven from transaction metadata.';
  } else if (!destinationProven) {
    note = 'Principal floor and exact swap input were verified, but the destination token delta could not be proven from transaction metadata.';
  } else {
    note = `Principal floor ${floor.toFixed(2)} USDC remains covered; exact swap input and destination receipt were proven from this transaction.`;
  }

  return {
    signature,
    sourceBefore: `${new Decimal(intent.snapshot.redeemableUsd || 0).toFixed(2)} USDC redeemable`,
    sourceAfter: `${remaining.toFixed(2)} USDC redeemable`,
    earningsRouted: `${routedRaw} raw USDC (withdrawal delta ${verifiedWithdrawnRaw})`,
    destinationReceived: destinationProven ? `${receivedRaw} raw ${intent.destinationSymbol}` : 'unknown',
    exposureBefore: floor.toFixed(2),
    exposureAfter: remaining.toFixed(2),
    preserved,
    verification,
    verificationNote: note,
  };
}
