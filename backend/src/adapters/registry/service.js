/**
 * Prepare and submit Overflow registry transactions.
 *
 * Skips silently when OVERFLOW_REGISTRY_PROGRAM_ID is unset so the live
 * Jupiter/Kamino product keeps working until the program is deployed.
 */
import { AccountRole, address } from '@solana/kit';
import { buildUnsignedTransaction } from '../solana/transaction.js';
import { sendRawTransactionBase64, confirmSignature } from '../solana/rpc.js';
import {
  createRuleInstruction,
  postReceiptInstruction,
  registryConfigured,
  programId,
  sourceKindFromRule,
} from './encoder.js';

const ROLE = {
  0: AccountRole.READONLY,
  1: AccountRole.WRITABLE,
  2: AccountRole.READONLY_SIGNER,
  3: AccountRole.WRITABLE_SIGNER,
};

function toKitInstruction(ix) {
  return {
    programAddress: address(ix.programAddress),
    accounts: ix.accounts.map((a) => ({
      address: address(a.address),
      role: ROLE[a.role],
    })),
    data: new Uint8Array(ix.data),
  };
}

export function registryStatus() {
  const id = String(process.env.OVERFLOW_REGISTRY_PROGRAM_ID || '').trim();
  return {
    configured: Boolean(id),
    programId: id || null,
    defaultProgramId: programId(),
  };
}

export async function prepareCreateRuleTx({ rule }) {
  if (!registryConfigured()) {
    return { available: false, reason: 'NOT_CONFIGURED' };
  }
  if (!rule?.sourceMint || !rule?.destinationMint) {
    return { available: false, reason: 'MISSING_MINTS' };
  }
  const ix = createRuleInstruction({
    owner: rule.wallet,
    ruleId: rule.id,
    sourceKind: sourceKindFromRule(rule),
    destinationMint: rule.destinationMint,
    sourceMint: rule.sourceMint,
  });
  const built = await buildUnsignedTransaction({
    owner: rule.wallet,
    instructions: [toKitInstruction(ix)],
  });
  if (built.simulation && built.simulation.ok === false) {
    return {
      available: false,
      reason: 'SIMULATION_FAILED',
      instruction: 'create_rule',
      programId: programId(),
      rulePda: ix.rulePda,
      bump: ix.bump,
      detail: built.simulation.err || 'create_rule simulation failed',
      logs: built.simulation.logs || [],
    };
  }
  return {
    available: true,
    instruction: 'create_rule',
    programId: programId(),
    rulePda: ix.rulePda,
    bump: ix.bump,
    ...built,
  };
}

export async function preparePostReceiptTx({ rule, receipt }) {
  if (!registryConfigured()) {
    return { available: false, reason: 'NOT_CONFIGURED' };
  }
  if (!rule?.onchainPda) {
    return { available: false, reason: 'RULE_NOT_ONCHAIN' };
  }
  const spent = receipt?.proofs?.authorisedSourceDelta
    ?? receipt?.outputs?.routedRaw
    ?? '0';
  const received = receipt?.proofs?.destinationReceivedRaw
    ?? receipt?.outputs?.destinationReceivedRaw
    ?? receipt?.outputs?.outputAmountResult
    ?? '0';
  const ix = postReceiptInstruction({
    owner: rule.wallet,
    ruleId: rule.id,
    rulePdaAddress: rule.onchainPda,
    executionKey: receipt.executionKey,
    sourceSpent: spent,
    destinationReceived: received,
    preserved: Boolean(receipt.preserved),
    swapSignature: receipt.signature,
  });
  const built = await buildUnsignedTransaction({
    owner: rule.wallet,
    instructions: [toKitInstruction(ix)],
  });
  if (built.simulation && built.simulation.ok === false) {
    return {
      available: false,
      reason: 'SIMULATION_FAILED',
      instruction: 'post_receipt',
      programId: programId(),
      receiptPda: ix.receiptPda,
      rulePda: ix.rulePda,
      bump: ix.bump,
      detail: built.simulation.err || 'post_receipt simulation failed',
      logs: built.simulation.logs || [],
    };
  }
  return {
    available: true,
    instruction: 'post_receipt',
    programId: programId(),
    receiptPda: ix.receiptPda,
    rulePda: ix.rulePda,
    bump: ix.bump,
    ...built,
  };
}

export async function submitRegistryTx({ signedTransaction }) {
  if (!signedTransaction) throw new Error('signedTransaction is required');
  const signature = await sendRawTransactionBase64(signedTransaction);
  const confirmation = await confirmSignature(signature);
  return { signature, confirmation };
}
