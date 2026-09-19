import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTransactionLog, explorerTxUrl } from '../src/services/transactions.js';

test('overflow harvest and registry signatures appear even without chain RPC', () => {
  const rows = mergeTransactionLog({
    chain: [],
    rules: [{ onchainSignature: 'RuleSig111', sourceSymbol: 'MCDx', updatedAt: '2026-01-02T00:00:00.000Z' }],
    receipts: [{
      id: 'r1',
      kind: 'DIVIDEND',
      status: 'CONFIRMED',
      signature: 'HarvestSig222',
      onchainSignature: 'ReceiptSig333',
      destinationSymbol: 'SPYx',
      createdAt: '2026-01-03T00:00:00.000Z',
    }],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].signature, 'HarvestSig222');
  assert.equal(rows[0].origin, 'OVERFLOW');
  assert.ok(rows.find((r) => r.role === 'create_rule'));
  assert.ok(rows.find((r) => r.role === 'post_receipt'));
});

test('chain signatures are tagged when Overflow already recorded them', () => {
  const rows = mergeTransactionLog({
    chain: [{ signature: 'HarvestSig222', blockTime: 1700000000, err: null, confirmationStatus: 'finalized', slot: 1 }],
    receipts: [{ id: 'r1', kind: 'INTEREST', status: 'CONFIRMED', signature: 'HarvestSig222', destinationSymbol: 'USDC', createdAt: '2026-01-01T00:00:00.000Z' }],
    rules: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origin, 'OVERFLOW');
  assert.match(rows[0].label, /Interest harvest/);
});

test('explorer URL adds the devnet cluster when NETWORK is devnet', () => {
  const prev = process.env.NETWORK;
  process.env.NETWORK = 'devnet';
  try {
    assert.equal(explorerTxUrl('AbC'), 'https://solscan.io/tx/AbC?cluster=devnet');
  } finally {
    if (prev === undefined) delete process.env.NETWORK;
    else process.env.NETWORK = prev;
  }
});
