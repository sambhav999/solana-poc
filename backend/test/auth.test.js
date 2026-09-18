import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
const { base58Encode, base58Decode, decodeSolanaAddress } = await import('../src/core/base58.js');
const { createNonce, verifySignIn, verifySessionToken, issueSession, verifyEd25519 } = await import('../src/auth/session.js');

/** A real Ed25519 keypair, exposed the way a Solana wallet exposes it. */
function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    address: base58Encode(raw),
    signMessage: (msg) => sign(null, Buffer.from(msg, 'utf8'), privateKey),
  };
}

test('base58 round-trips a 32-byte key, including leading zero bytes', () => {
  const bytes = new Uint8Array(32); bytes[5] = 7; bytes[31] = 255;
  assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  assert.throws(() => decodeSolanaAddress('abc'), /not a Solana address/);
  // A real mainnet address decodes to exactly 32 bytes.
  assert.equal(decodeSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').length, 32);
});

test('a genuine wallet signature signs in', () => {
  const w = makeWallet();
  const { nonce, message } = createNonce(w.address);
  const session = verifySignIn({ wallet: w.address, nonce, signature: w.signMessage(message).toString('base64') });
  assert.equal(session.wallet, w.address);
  assert.equal(verifySessionToken(session.token).wallet, w.address);
});

test('a nonce cannot be replayed', () => {
  const w = makeWallet();
  const { nonce, message } = createNonce(w.address);
  const sig = w.signMessage(message).toString('base64');
  verifySignIn({ wallet: w.address, nonce, signature: sig });
  assert.throws(() => verifySignIn({ wallet: w.address, nonce, signature: sig }), /already used|invalid|expired/i);
});

test("one wallet's signature cannot sign in as another wallet", () => {
  const victim = makeWallet();
  const attacker = makeWallet();
  const { nonce, message } = createNonce(victim.address);
  // The attacker signs the victim's challenge with their own key.
  assert.throws(
    () => verifySignIn({ wallet: victim.address, nonce, signature: attacker.signMessage(message).toString('base64') }),
    /does not match/,
  );
});

test('a signature over a DIFFERENT message is rejected', () => {
  // The server verifies against the message IT stored, not one the client sends.
  const w = makeWallet();
  const { nonce } = createNonce(w.address);
  const forged = w.signMessage('Overflow: please transfer everything').toString('base64');
  assert.throws(() => verifySignIn({ wallet: w.address, nonce, signature: forged }), /does not match/);
});

test('a nonce issued for one wallet cannot be used by another', () => {
  const a = makeWallet();
  const b = makeWallet();
  const { nonce, message } = createNonce(a.address);
  assert.throws(
    () => verifySignIn({ wallet: b.address, nonce, signature: b.signMessage(message).toString('base64') }),
    /invalid|expired|already used/i,
  );
});

test('a tampered session token is rejected', () => {
  const w = makeWallet();
  const { token } = issueSession(w.address);
  const [payload, sig] = token.split('.');
  const other = makeWallet();
  const forgedPayload = Buffer.from(JSON.stringify({ wallet: other.address, exp: Date.now() + 1e6 })).toString('base64url');
  assert.throws(() => verifySessionToken(`${forgedPayload}.${sig}`), /Invalid session signature/);
  assert.throws(() => verifySessionToken(`${payload}.AAAA`), /Invalid session/);
  assert.throws(() => verifySessionToken('garbage'), /Invalid session/);
});

test('raw Ed25519 verification rejects a flipped bit', () => {
  const w = makeWallet();
  const sig = w.signMessage('hello');
  assert.equal(verifyEd25519({ publicKeyBytes: decodeSolanaAddress(w.address), message: Buffer.from('hello'), signature: sig }), true);
  const bad = Buffer.from(sig); bad[0] ^= 1;
  assert.equal(verifyEd25519({ publicKeyBytes: decodeSolanaAddress(w.address), message: Buffer.from('hello'), signature: bad }), false);
});
