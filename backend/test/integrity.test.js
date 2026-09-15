import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { transactionMessageHash } from '../src/adapters/solana/rpc.js';

process.env.DATABASE_PATH = ':memory:';
const { createRule, getRule, updateRule } = await import('../src/db/rules.js');
const { createIntent, getIntent, consumeIntent, getOpenIntent } = await import('../src/db/intents.js');
const { createReceipt, hasConfirmedExecution, listReceiptsForRule } = await import('../src/db/receipts.js');

/** Build a fake wire transaction: [1 sig count][64 sig bytes][message]. */
function wireTx(message, signatureByte = 0) {
  return Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64, signatureByte),
    Buffer.from(message),
  ]).toString('base64');
}

test('signing does not change the message hash, but tampering does', () => {
  const message = 'overflow-authorised-swap-payload';
  const unsigned = wireTx(message, 0);
  const signed = wireTx(message, 0xab);
  const tampered = wireTx('overflow-authorised-swap-payloaX', 0xab);

  assert.equal(transactionMessageHash(unsigned), transactionMessageHash(signed),
    'a wallet signature must not change the message hash');
  assert.notEqual(transactionMessageHash(signed), transactionMessageHash(tampered),
    'a different message must not pass as the authorised one');

  // The hash is exactly SHA-256 over the message bytes, signatures excluded.
  assert.equal(
    transactionMessageHash(signed),
    createHash('sha256').update(Buffer.from(message)).digest('hex'),
  );
});

test('an intent records what the server authorised and is single-use', () => {
  const rule = createRule({
    wallet: 'W1', sourceType: 'XSTOCK_DIVIDEND', sourceId: 'MCDx', sourceSymbol: 'MCDx',
    sourceMint: 'srcMint', earningsType: 'DIVIDEND', destinationMint: 'dstMint',
    destinationSymbol: 'SPYx', minExecutionUsdAtomic: '5000000', maxSlippageBps: 50,
  });
  const intent = createIntent({
    ruleId: rule.id, wallet: 'W1', kind: 'DIVIDEND', stage: 'SWAP',
    executionKey: 'key-1', messageHash: 'abc123', jupiterRequestId: 'req-1',
    authorisedRaw: '4973045', sourceMint: 'srcMint', destinationMint: 'dstMint',
    snapshot: { rawBalanceAtomic: '1000000000', multiplierBefore: '1.01', multiplierAfter: '1.02' },
  });

  assert.equal(intent.status, 'OPEN');
  assert.equal(intent.authorisedRaw, '4973045');
  assert.equal(intent.snapshot.multiplierAfter, '1.02');
  assert.equal(getOpenIntent(rule.id).id, intent.id);

  consumeIntent(intent.id);
  assert.equal(getIntent(intent.id).status, 'CONSUMED');
  assert.equal(getOpenIntent(rule.id), null, 'a consumed intent must not be reusable');
});

test('a FAILED execution leaves the earnings routable', () => {
  // The bug this guards: marking an event processed on failure would make a
  // transient RPC problem cost the user that dividend permanently.
  const rule = createRule({
    wallet: 'W2', sourceType: 'XSTOCK_DIVIDEND', sourceId: 'MCDx', sourceSymbol: 'MCDx',
    sourceMint: 'srcMint', earningsType: 'DIVIDEND', destinationMint: 'dstMint',
    destinationSymbol: 'SPYx', minExecutionUsdAtomic: '5000000', maxSlippageBps: 50,
  });
  createReceipt({
    ruleId: rule.id, wallet: 'W2', kind: 'DIVIDEND', mode: 'LIVE', status: 'FAILED',
    executionKey: 'key-fail', inputs: {}, outputs: {},
    verification: 'FAILED', verificationNote: 'Transaction never confirmed', preserved: false,
  });

  assert.equal(hasConfirmedExecution('key-fail'), false,
    'a failed execution must not satisfy the idempotency guard');
  const receipts = listReceiptsForRule(rule.id);
  assert.equal(receipts[0].verification, 'FAILED');
  assert.equal(receipts[0].preserved, false);
});

test('a confirmed execution blocks a replay of the same event', () => {
  const rule = createRule({
    wallet: 'W3', sourceType: 'XSTOCK_DIVIDEND', sourceId: 'MCDx', sourceSymbol: 'MCDx',
    sourceMint: 'srcMint', earningsType: 'DIVIDEND', destinationMint: 'dstMint',
    destinationSymbol: 'SPYx', minExecutionUsdAtomic: '5000000', maxSlippageBps: 50,
  });
  createReceipt({
    ruleId: rule.id, wallet: 'W3', kind: 'DIVIDEND', mode: 'LIVE', status: 'CONFIRMED',
    executionKey: 'key-ok', signature: 'sig-1', inputs: {}, outputs: {},
    verification: 'VERIFIED_ON_CHAIN', preserved: true,
  });
  assert.equal(hasConfirmedExecution('key-ok'), true);
});

test('receipts carry a verification verdict separate from delivery status', () => {
  const rule = createRule({
    wallet: 'W4', sourceType: 'KAMINO_USDC', sourceId: 'vault', earningsType: 'INTEREST',
    destinationMint: 'dstMint', destinationSymbol: 'NVDAx',
    minExecutionUsdAtomic: '5000000', maxSlippageBps: 50, principalFloorAtomic: '10000000000',
  });
  // Delivered, but the chain could not prove both legs.
  createReceipt({
    ruleId: rule.id, wallet: 'W4', kind: 'INTEREST', mode: 'LIVE', status: 'CONFIRMED',
    executionKey: 'key-unv', signature: 'sig-2', inputs: {}, outputs: {},
    verification: 'UNVERIFIED', verificationNote: 'destination delta unreadable',
    preserved: true, proofs: { exactSourceSpend: true, destinationIncreased: false },
  });
  const r = listReceiptsForRule(rule.id)[0];
  assert.equal(r.status, 'CONFIRMED', 'the transaction did land');
  assert.equal(r.verification, 'UNVERIFIED', 'but it is not proven');
  assert.equal(r.proofs.destinationIncreased, false);
  assert.equal(r.preserved, true);
});

test('a drifted rule pauses with a reason and can be reconfirmed', () => {
  const rule = createRule({
    wallet: 'W5', sourceType: 'KAMINO_USDC', sourceId: 'vault', earningsType: 'INTEREST',
    destinationMint: 'dstMint', destinationSymbol: 'NVDAx',
    minExecutionUsdAtomic: '5000000', maxSlippageBps: 50,
    principalFloorAtomic: '10000000000', vaultSharesBaseline: '9000000',
  });
  assert.equal(rule.vaultSharesBaseline, '9000000');

  const paused = updateRule(rule.id, {
    status: 'PAUSED',
    pauseReason: 'VAULT_SHARES_DRIFT: share balance changed outside Overflow',
  });
  assert.equal(paused.status, 'PAUSED');
  assert.match(paused.pauseReason, /VAULT_SHARES_DRIFT/);

  const resumed = updateRule(rule.id, { status: 'ACTIVE', pauseReason: null, vaultSharesBaseline: '9500000' });
  assert.equal(resumed.status, 'ACTIVE');
  assert.equal(resumed.pauseReason, null);
  assert.equal(resumed.vaultSharesBaseline, '9500000');
});
