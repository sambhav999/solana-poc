/**
 * Overflow Receipt Registry encoder.
 *
 * Matches programs/overflow-registry (native Solana program, Anchor-style
 * 8-byte sha256 discriminators). This program never holds tokens.
 */
import { createHash } from 'node:crypto';
import { decodeSolanaAddress, base58Decode, base58Encode } from '../../core/base58.js';
import { findProgramAddress } from './pda.js';

export const DEFAULT_PROGRAM_ID = 'nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp';
export const RULE_SEED = 'rule';
export const RECEIPT_SEED = 'receipt';
export const SOURCE_KIND = { DIVIDEND: 0, INTEREST: 1 };

export const ACCOUNT_ROLE = {
  READONLY: 0,
  WRITABLE: 1,
  READONLY_SIGNER: 2,
  WRITABLE_SIGNER: 3,
};

export function discriminator(kind) {
  return createHash('sha256').update(kind).digest().subarray(0, 8);
}

export const CREATE_RULE_DISC = discriminator('global:create_rule');
export const POST_RECEIPT_DISC = discriminator('global:post_receipt');
export const RULE_ACCOUNT_DISC = discriminator('account:Rule');
export const RECEIPT_ACCOUNT_DISC = discriminator('account:Receipt');

export function programId() {
  return process.env.OVERFLOW_REGISTRY_PROGRAM_ID || DEFAULT_PROGRAM_ID;
}

export function registryConfigured() {
  return Boolean(String(process.env.OVERFLOW_REGISTRY_PROGRAM_ID || '').trim());
}

export function uuidToBytes(id) {
  const hex = String(id || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`rule id is not a 16-byte uuid: ${id}`);
  return Buffer.from(hex, 'hex');
}

export function executionKeyToBytes(hex) {
  const s = String(hex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('executionKey must be 32-byte sha256 hex');
  return Buffer.from(s, 'hex');
}

export function signatureToBytes(signature) {
  if (!signature) return Buffer.alloc(64);
  const bytes = Buffer.from(base58Decode(signature));
  if (bytes.length !== 64) throw new Error(`swap signature decodes to ${bytes.length} bytes, expected 64`);
  return bytes;
}

export function sourceKindFromRule(rule) {
  if (rule?.sourceType === 'KAMINO_USDC' || rule?.earningsType === 'INTEREST') return SOURCE_KIND.INTEREST;
  return SOURCE_KIND.DIVIDEND;
}

export function encodeCreateRule({ ruleId, sourceKind, destinationMint, sourceMint }) {
  const ruleIdBytes = Buffer.isBuffer(ruleId) || ruleId instanceof Uint8Array
    ? Buffer.from(ruleId)
    : uuidToBytes(ruleId);
  if (ruleIdBytes.length !== 16) throw new Error('rule_id must be 16 bytes');
  const dest = Buffer.from(decodeSolanaAddress(destinationMint));
  const source = Buffer.from(decodeSolanaAddress(sourceMint));
  const kind = Number(sourceKind);
  if (kind !== 0 && kind !== 1) throw new Error('source_kind must be 0 (dividend) or 1 (interest)');
  return Buffer.concat([CREATE_RULE_DISC, ruleIdBytes, Buffer.from([kind]), dest, source]);
}

export function encodePostReceipt({
  executionKey,
  sourceSpent,
  destinationReceived,
  preserved,
  swapSignature,
}) {
  const key = Buffer.isBuffer(executionKey) || executionKey instanceof Uint8Array
    ? Buffer.from(executionKey)
    : executionKeyToBytes(executionKey);
  if (key.length !== 32) throw new Error('execution_key must be 32 bytes');
  const spent = Buffer.alloc(8);
  spent.writeBigUInt64LE(BigInt(sourceSpent ?? 0));
  const received = Buffer.alloc(8);
  received.writeBigUInt64LE(BigInt(destinationReceived ?? 0));
  const flag = Buffer.from([preserved ? 1 : 0]);
  const sig = Buffer.isBuffer(swapSignature) || swapSignature instanceof Uint8Array
    ? Buffer.from(swapSignature)
    : signatureToBytes(swapSignature);
  if (sig.length !== 64) throw new Error('swap_signature must be 64 bytes');
  return Buffer.concat([POST_RECEIPT_DISC, key, spent, received, flag, sig]);
}

export function rulePda({ owner, ruleId, programAddress = programId() }) {
  const ruleIdBytes = Buffer.isBuffer(ruleId) || ruleId instanceof Uint8Array
    ? Buffer.from(ruleId)
    : uuidToBytes(ruleId);
  return findProgramAddress(
    [Buffer.from(RULE_SEED), Buffer.from(decodeSolanaAddress(owner)), ruleIdBytes],
    programAddress,
  );
}

export function receiptPda({ owner, executionKey, programAddress = programId() }) {
  const key = Buffer.isBuffer(executionKey) || executionKey instanceof Uint8Array
    ? Buffer.from(executionKey)
    : executionKeyToBytes(executionKey);
  return findProgramAddress(
    [Buffer.from(RECEIPT_SEED), Buffer.from(decodeSolanaAddress(owner)), key],
    programAddress,
  );
}

export function createRuleAccounts({ rulePdaAddress, owner }) {
  return [
    { address: rulePdaAddress, role: ACCOUNT_ROLE.WRITABLE },
    { address: owner, role: ACCOUNT_ROLE.WRITABLE_SIGNER },
    { address: '11111111111111111111111111111111', role: ACCOUNT_ROLE.READONLY },
  ];
}

export function postReceiptAccounts({ receiptPdaAddress, rulePdaAddress, owner }) {
  return [
    { address: receiptPdaAddress, role: ACCOUNT_ROLE.WRITABLE },
    { address: rulePdaAddress, role: ACCOUNT_ROLE.READONLY },
    { address: owner, role: ACCOUNT_ROLE.WRITABLE_SIGNER },
    { address: '11111111111111111111111111111111', role: ACCOUNT_ROLE.READONLY },
  ];
}

export function createRuleInstruction(params) {
  const { address: pda, bump } = rulePda(params);
  return {
    programAddress: params.programAddress || programId(),
    accounts: createRuleAccounts({ rulePdaAddress: pda, owner: params.owner }),
    data: encodeCreateRule(params),
    rulePda: pda,
    bump,
  };
}

export function postReceiptInstruction(params) {
  const { address: rec, bump } = receiptPda(params);
  const { address: ruleAddress } = params.rulePdaAddress
    ? { address: params.rulePdaAddress }
    : rulePda({ owner: params.owner, ruleId: params.ruleId, programAddress: params.programAddress });
  return {
    programAddress: params.programAddress || programId(),
    accounts: postReceiptAccounts({
      receiptPdaAddress: rec,
      rulePdaAddress: ruleAddress,
      owner: params.owner,
    }),
    data: encodePostReceipt(params),
    receiptPda: rec,
    rulePda: ruleAddress,
    bump,
  };
}

export function encodeAddress(addr) {
  return base58Encode(decodeSolanaAddress(addr));
}
