/**
 * Wallet authentication: prove control of a wallet by signing a one-time message.
 *
 * Without this, every endpoint trusted a `?wallet=` parameter, so anyone could
 * read, create or delete any wallet's rules. Now the wallet an endpoint acts for
 * comes ONLY from a verified session.
 *
 *   1. POST /auth/nonce   server stores a single-use message for that wallet
 *   2. wallet signs it    (off-chain; authorises no transaction, moves no funds)
 *   3. POST /auth/verify  server checks the Ed25519 signature over the STORED
 *                         message -- never a client-supplied one -- and issues
 *                         an HMAC-signed session token
 *
 * Signature verification uses Node's built-in Ed25519; no crypto dependency.
 */
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { decodeSolanaAddress, base58Encode, base58Decode } from '../core/base58.js';
import { saveNonce, consumeNonce } from '../db/nonces.js';

export const SESSION_TTL_MS = 30 * 60 * 1000;
export const NONCE_TTL_MS = 10 * 60 * 1000;

// DER prefix that wraps a raw 32-byte Ed25519 public key as SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let ephemeralSecret = null;
function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET (>= 32 chars) is required in production');
  }
  // Development only: an ephemeral secret, so sessions end on restart.
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString('hex');
    console.warn('[auth] SESSION_SECRET not set; using an ephemeral secret. Sessions will not survive a restart.');
  }
  return ephemeralSecret;
}

const b64url = (x) => Buffer.from(x).toString('base64url');
const hmac = (payload) => createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

/** Normalise and validate an address; throws if it is not a 32-byte key. */
export function canonicalWallet(wallet) {
  return base58Encode(decodeSolanaAddress(String(wallet).trim()));
}

export function createNonce(wallet, { domain = 'Overflow' } = {}) {
  const address = canonicalWallet(wallet);
  const nonce = randomBytes(18).toString('hex');
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();
  const message = [
    `${domain} wants you to sign in with your Solana account:`,
    address,
    '',
    'Signing proves you control this wallet. It does not authorise a transaction or move any funds.',
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join('\n');
  saveNonce({ wallet: address, nonce, message, expiresAt });
  return { wallet: address, nonce, message, expiresAt };
}

/** Raw Ed25519 check: does `signature` sign `message` for this 32-byte public key? */
export function verifyEd25519({ publicKeyBytes, message, signature }) {
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, Buffer.from(message), key, Buffer.from(signature));
}

/** Accept base64 (what the browser sends) or base58 (what Solana tooling emits). */
function decodeSignature(sig) {
  const s = String(sig);
  const asB64 = Buffer.from(s, 'base64');
  if (asB64.length === 64) return asB64;
  try {
    const asB58 = Buffer.from(base58Decode(s));
    if (asB58.length === 64) return asB58;
  } catch { /* fall through */ }
  throw new Error('Signature must be 64 bytes, base64 or base58.');
}

export function verifySignIn({ wallet, nonce, signature }) {
  const address = canonicalWallet(wallet);
  // The message comes from OUR store, and consuming it makes the nonce single-use.
  const message = consumeNonce({ wallet: address, nonce });
  if (!message) throw new Error('Nonce is invalid, expired, or already used.');
  const ok = verifyEd25519({
    publicKeyBytes: decodeSolanaAddress(address),
    message: Buffer.from(message, 'utf8'),
    signature: decodeSignature(signature),
  });
  if (!ok) throw new Error('Signature does not match this wallet.');
  return issueSession(address);
}

export function issueSession(wallet) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = b64url(JSON.stringify({ wallet, exp }));
  return { token: `${payload}.${hmac(payload)}`, wallet, expiresAt: new Date(exp).toISOString() };
}

export function verifySessionToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) throw new Error('Invalid session.');
  const expected = Buffer.from(hmac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error('Invalid session signature.');
  }
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!decoded.wallet || !decoded.exp || decoded.exp < Date.now()) throw new Error('Session expired.');
  return { wallet: canonicalWallet(decoded.wallet), exp: decoded.exp };
}

/** Express helper: the authenticated wallet, or a 401 already sent. */
export function requireSession(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Sign in with your wallet first.', code: 'AUTH_REQUIRED' }); return null; }
  try {
    return verifySessionToken(token).wallet;
  } catch (err) {
    res.status(401).json({ error: err.message, code: 'AUTH_INVALID' });
    return null;
  }
}
