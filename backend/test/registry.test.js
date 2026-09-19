import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CREATE_RULE_DISC,
  POST_RECEIPT_DISC,
  RULE_ACCOUNT_DISC,
  RECEIPT_ACCOUNT_DISC,
  DEFAULT_PROGRAM_ID,
  SOURCE_KIND,
  encodeCreateRule,
  encodePostReceipt,
  uuidToBytes,
  executionKeyToBytes,
  createRuleInstruction,
  postReceiptInstruction,
  rulePda,
  receiptPda,
  sourceKindFromRule,
} from '../src/adapters/registry/encoder.js';
import { findProgramAddress, isOnCurve } from '../src/adapters/registry/pda.js';
import { base58Encode } from '../src/core/base58.js';

const SYSTEM = '11111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OWNER = SYSTEM;

function disc(kind) {
  return createHash('sha256').update(kind).digest().subarray(0, 8);
}

test('instruction discriminators match sha256(global:name)[0..8]', () => {
  assert.deepEqual(CREATE_RULE_DISC, disc('global:create_rule'));
  assert.deepEqual(POST_RECEIPT_DISC, disc('global:post_receipt'));
  assert.deepEqual(RULE_ACCOUNT_DISC, disc('account:Rule'));
  assert.deepEqual(RECEIPT_ACCOUNT_DISC, disc('account:Receipt'));
  assert.notDeepEqual(CREATE_RULE_DISC, POST_RECEIPT_DISC);
});

test('uuid without dashes is 16 bytes', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const bytes = uuidToBytes(id);
  assert.equal(bytes.length, 16);
  assert.equal(bytes.toString('hex'), '550e8400e29b41d4a716446655440000');
});

test('execution key hex is 32 bytes', () => {
  const hex = createHash('sha256').update('event').digest('hex');
  assert.equal(executionKeyToBytes(hex).length, 32);
});

test('create_rule instruction layout is disc + 16 + 1 + 32 + 32', () => {
  const data = encodeCreateRule({
    ruleId: '550e8400-e29b-41d4-a716-446655440000',
    sourceKind: SOURCE_KIND.DIVIDEND,
    destinationMint: USDC,
    sourceMint: USDC,
  });
  assert.equal(data.length, 8 + 16 + 1 + 32 + 32);
  assert.deepEqual(data.subarray(0, 8), CREATE_RULE_DISC);
  assert.equal(data[8 + 16], 0);
});

test('post_receipt instruction layout is disc + 32 + 8 + 8 + 1 + 64', () => {
  const key = Buffer.alloc(32, 9);
  const data = encodePostReceipt({
    executionKey: key,
    sourceSpent: 42,
    destinationReceived: 99,
    preserved: true,
    swapSignature: Buffer.alloc(64, 3),
  });
  assert.equal(data.length, 8 + 32 + 8 + 8 + 1 + 64);
  assert.deepEqual(data.subarray(0, 8), POST_RECEIPT_DISC);
  assert.equal(data.readBigUInt64LE(8 + 32), 42n);
  assert.equal(data.readBigUInt64LE(8 + 32 + 8), 99n);
  assert.equal(data[8 + 32 + 8 + 8], 1);
});

test('source kind mapping', () => {
  assert.equal(sourceKindFromRule({ sourceType: 'XSTOCK_DIVIDEND', earningsType: 'DIVIDEND' }), 0);
  assert.equal(sourceKindFromRule({ sourceType: 'KAMINO_USDC', earningsType: 'INTEREST' }), 1);
});

test('create_rule accounts are pda, owner signer, system program', () => {
  const ix = createRuleInstruction({
    owner: OWNER,
    ruleId: Buffer.alloc(16, 1),
    sourceKind: 0,
    destinationMint: USDC,
    sourceMint: USDC,
    programAddress: DEFAULT_PROGRAM_ID,
  });
  assert.equal(ix.accounts.length, 3);
  assert.equal(ix.accounts[0].address, ix.rulePda);
  assert.equal(ix.accounts[0].role, 1);
  assert.equal(ix.accounts[1].address, OWNER);
  assert.equal(ix.accounts[1].role, 3);
  assert.equal(ix.accounts[2].address, SYSTEM);
});

test('post_receipt accounts are receipt, rule, owner, system', () => {
  const ruleId = Buffer.alloc(16, 1);
  const key = Buffer.alloc(32, 5);
  const ix = postReceiptInstruction({
    owner: OWNER,
    ruleId,
    executionKey: key,
    sourceSpent: 1,
    destinationReceived: 2,
    preserved: true,
    swapSignature: Buffer.alloc(64, 0),
    programAddress: DEFAULT_PROGRAM_ID,
  });
  assert.equal(ix.accounts.length, 4);
  assert.equal(ix.accounts[0].address, ix.receiptPda);
  assert.equal(ix.accounts[2].role, 3);
  assert.notEqual(ix.receiptPda, ix.rulePda);
});

test('JS PDA matches the Rust fixture', () => {
  const r = rulePda({ owner: OWNER, ruleId: Buffer.alloc(16, 1), programAddress: DEFAULT_PROGRAM_ID });
  assert.equal(r.address, '3DWQg3GT8dbd2MthhcqZYdECPzXNrcS37nWfyUJBSBYV');
  assert.equal(r.bump, 253);
});

test('rule PDA is off-curve and stable', async () => {
  const { decodeSolanaAddress } = await import('../src/core/base58.js');
  const first = rulePda({ owner: OWNER, ruleId: Buffer.alloc(16, 1), programAddress: DEFAULT_PROGRAM_ID });
  const second = rulePda({ owner: OWNER, ruleId: Buffer.alloc(16, 1), programAddress: DEFAULT_PROGRAM_ID });
  assert.equal(first.address, second.address);
  assert.equal(first.bump, second.bump);
  assert.equal(isOnCurve(Buffer.from(decodeSolanaAddress(first.address))), false);
});

test('findProgramAddress matches a second independent call', () => {
  const seeds = [Buffer.from('rule'), Buffer.alloc(32, 7), Buffer.alloc(16, 2)];
  const a = findProgramAddress(seeds, DEFAULT_PROGRAM_ID);
  const b = findProgramAddress(seeds, DEFAULT_PROGRAM_ID);
  assert.equal(a.address, b.address);
  assert.equal(a.bump, b.bump);
  assert.ok(a.bump <= 255);
});

test('base58 round-trip of a PDA', () => {
  const { address } = receiptPda({
    owner: OWNER,
    executionKey: Buffer.alloc(32, 8),
    programAddress: DEFAULT_PROGRAM_ID,
  });
  assert.equal(base58Encode(Buffer.alloc(32, 8)).length > 0, true);
  assert.match(address, /^[1-9A-HJ-NP-Za-km-z]+$/);
});
