/**
 * Solana program-derived addresses, matching Pubkey::find_program_address.
 */
import { createHash } from 'node:crypto';
import { decodeSolanaAddress, base58Encode } from '../../core/base58.js';

const PDA_MARKER = Buffer.from('ProgramDerivedAddress');
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const I = 19681161376737505956054637876043091955502033077542175925401726664925855609105n;

function modPow(base, exp, mod) {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** True when 32 bytes are a valid compressed ed25519 point. PDAs must not be. */
export function isOnCurve(bytes) {
  if (!bytes || bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 0; i < 32; i++) y |= BigInt(bytes[i]) << (8n * BigInt(i));
  const xSign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 + P - 1n) % P;
  const v = (D * y2 + 1n) % P;
  let x = modPow((u * modPow(v, P - 2n, P)) % P, (P + 3n) / 8n, P);
  const vx2 = (v * x * x) % P;
  if (vx2 !== u) {
    if (vx2 !== (P - u) % P) return false;
    x = (x * I) % P;
  }
  if (x === 0n && xSign === 1n) return false;
  if ((x & 1n) !== xSign) x = (P - x) % P;
  return true;
}

export function createProgramAddress(seeds, programAddress) {
  if (seeds.length > 16) throw new Error('too many PDA seeds');
  const program = Buffer.from(decodeSolanaAddress(programAddress));
  const hash = createHash('sha256');
  for (const seed of seeds) {
    const buf = Buffer.isBuffer(seed) ? seed : Buffer.from(seed);
    if (buf.length > 32) throw new Error('PDA seed longer than 32 bytes');
    hash.update(buf);
  }
  hash.update(program);
  hash.update(PDA_MARKER);
  const digest = hash.digest();
  if (isOnCurve(digest)) throw new Error('invalid seeds: address is on curve');
  return base58Encode(digest);
}

export function findProgramAddress(seeds, programAddress) {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      const address = createProgramAddress([...seeds, Buffer.from([bump])], programAddress);
      return { address, bump };
    } catch {
      /* try next bump */
    }
  }
  throw new Error('unable to find a viable program address');
}
