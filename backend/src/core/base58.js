/**
 * Base58 (Bitcoin alphabet), as used for Solana addresses and signatures.
 * Dependency-free; BigInt keeps it exact for any length.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Decode(input) {
  const s = String(input);
  if (!s.length) throw new Error('base58: empty input');
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error(`base58: invalid character "${c}"`);
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes) {
  const buf = Uint8Array.from(bytes);
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** A Solana public key is exactly 32 bytes. Anything else is not an address. */
export function decodeSolanaAddress(address) {
  const bytes = base58Decode(address);
  if (bytes.length !== 32) throw new Error(`not a Solana address (decodes to ${bytes.length} bytes, expected 32)`);
  return bytes;
}
