import { createHash } from 'node:crypto';
/**
 * Minimal Solana JSON-RPC reader.
 *
 * Deliberately dependency-free: every call here is a read, and the browser wallet
 * owns all signing. Keeping reads on plain fetch means the backend has no key
 * material and no heavy SDK in the hot path.
 *
 * A public RPC endpoint will rate-limit almost immediately under real use. Set
 * SOLANA_RPC_URL to a dedicated provider before any live demo.
 */

export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function rpcUrl() {
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

let requestId = 0;

export async function rpc(method, params, { timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function getSlot() {
  return rpc('getSlot', [{ commitment: 'confirmed' }]);
}

export async function getSolBalanceLamports(owner) {
  const r = await rpc('getBalance', [owner, { commitment: 'confirmed' }]);
  return BigInt(r?.value ?? 0);
}

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Which program owns an account.
 *
 * Only a System Program account can pay transaction fees. A token account or PDA
 * cannot, and the chain reports that as `InvalidAccountForFee` with no further
 * explanation, so callers check ownership up front.
 */
export async function getAccountOwnerProgram(addressStr) {
  const r = await rpc('getAccountInfo', [addressStr, { encoding: 'base64', commitment: 'confirmed' }]);
  const value = r?.value;
  if (!value) return null; // account does not exist yet; system-owned once funded
  return { owner: value.owner, lamports: BigInt(value.lamports ?? 0), executable: Boolean(value.executable) };
}

/**
 * Read a mint, including the Token-2022 Scaled UI Amount configuration.
 *
 * The chain stores the current multiplier, a scheduled next multiplier, and the
 * timestamp at which the next one takes effect. The EFFECTIVE multiplier is
 * therefore time-dependent, and reading `multiplier` alone gives a stale value
 * after an activation has passed.
 */
export async function getMintInfo(mint) {
  const r = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const value = r?.value;
  if (!value) throw new Error(`mint not found: ${mint}`);
  const info = value.data?.parsed?.info;
  if (!info) throw new Error(`mint ${mint} is not a parseable token mint`);

  const extensions = info.extensions || [];
  const scaled = extensions.find((e) => e.extension === 'scaledUiAmountConfig')?.state ?? null;

  let effectiveMultiplier = null;
  let pendingMultiplier = null;
  let pendingEffectiveAt = null;
  if (scaled) {
    const nowSec = Math.floor(Date.now() / 1000);
    const effectiveAt = Number(scaled.newMultiplierEffectiveTimestamp ?? 0);
    pendingEffectiveAt = effectiveAt || null;
    if (effectiveAt && nowSec >= effectiveAt) {
      effectiveMultiplier = String(scaled.newMultiplier);
    } else {
      effectiveMultiplier = String(scaled.multiplier);
      if (effectiveAt) pendingMultiplier = String(scaled.newMultiplier);
    }
  }

  return {
    mint,
    program: value.owner,
    isToken2022: value.owner === TOKEN_2022_PROGRAM,
    decimals: Number(info.decimals),
    supplyRaw: String(info.supply),
    extensions: extensions.map((e) => e.extension),
    scaledUiAmountConfig: scaled,
    effectiveMultiplier,
    pendingMultiplier,
    pendingEffectiveAt,
    // Surfaced because they are real holder risks worth disclosing, not hidden.
    hasTransferHook: extensions.some((e) => e.extension === 'transferHook'),
    hasPermanentDelegate: extensions.some((e) => e.extension === 'permanentDelegate'),
    isPausable: extensions.some((e) => e.extension === 'pausableConfig'),
  };
}

/**
 * Raw token balance for an owner+mint.
 *
 * Returns the RAW atomic amount, which is what every transaction and every piece
 * of dividend maths uses. `uiAmount` is the multiplier-scaled display figure and
 * must never be fed into a transaction.
 */
export async function getTokenBalance({ owner, mint }) {
  const r = await rpc('getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  const accounts = r?.value ?? [];
  if (!accounts.length) {
    return { rawAtomic: '0', uiAmount: '0', decimals: null, accounts: 0, hasAccount: false };
  }
  let total = 0n;
  let decimals = null;
  let uiAmountString = null;
  for (const acc of accounts) {
    const amt = acc.account?.data?.parsed?.info?.tokenAmount;
    if (!amt) continue;
    total += BigInt(amt.amount);
    decimals = Number(amt.decimals);
    uiAmountString = amt.uiAmountString ?? uiAmountString;
  }
  return {
    rawAtomic: total.toString(),
    uiAmount: uiAmountString ?? '0',
    decimals,
    accounts: accounts.length,
    hasAccount: true,
    address: accounts[0]?.pubkey ?? null,
  };
}

/**
 * Cross-check the API-reported multiplier against the chain before acting on it.
 * The API is convenient; the chain is authoritative.
 */
export async function crossCheckMultiplier({ mint, apiMultiplier }) {
  try {
    const info = await getMintInfo(mint);
    if (!info.effectiveMultiplier) return { checked: false, reason: 'NO_SCALED_UI_CONFIG' };
    const matches = normalizeDecimalString(info.effectiveMultiplier) === normalizeDecimalString(apiMultiplier);
    return {
      checked: true,
      matches,
      onchain: info.effectiveMultiplier,
      api: String(apiMultiplier),
      pendingMultiplier: info.pendingMultiplier,
      pendingEffectiveAt: info.pendingEffectiveAt,
    };
  } catch (err) {
    return { checked: false, reason: err.message };
  }
}

function normalizeDecimalString(v) {
  const s = String(v);
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/* ------------------------------------------------------ write-path reads -- */

export async function getLatestBlockhash() {
  const r = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return { blockhash: r.value.blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
}

/** Simulate before asking anyone to sign. A failing simulation must never reach a wallet. */
export async function simulateTransactionBase64(base64) {
  const r = await rpc('simulateTransaction', [
    base64,
    { encoding: 'base64', commitment: 'confirmed', replaceRecentBlockhash: true, sigVerify: false },
  ]);
  return {
    ok: !r.value.err,
    err: r.value.err ?? null,
    logs: r.value.logs ?? [],
    unitsConsumed: r.value.unitsConsumed ?? null,
  };
}

export async function getSignaturesForAddress(address, { limit = 40 } = {}) {
  const rows = await rpc('getSignaturesForAddress', [address, { limit }]);
  return (rows || []).map((r) => ({
    signature: r.signature,
    slot: r.slot ?? null,
    err: r.err ?? null,
    blockTime: r.blockTime ?? null,
    confirmationStatus: r.confirmationStatus ?? null,
  }));
}

export async function sendRawTransactionBase64(base64, { skipPreflight = false, maxRetries = 3 } = {}) {
  return rpc('sendTransaction', [
    base64,
    { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed', maxRetries },
  ]);
}

/**
 * Poll a signature to a terminal state.
 *
 * "Confirmed" needs a definition or the success rule is meaningless. A signature
 * is treated as confirmed only at 'confirmed'/'finalized' with no error; an
 * on-chain error is a failure, and running out of time is NOT success -- it is
 * reported as UNKNOWN so the caller refuses to write a CONFIRMED receipt.
 */
export async function confirmSignature(signature, { timeoutMs = 60_000, intervalMs = 1_500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const r = await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const status = r?.value?.[0] ?? null;
    lastStatus = status;
    if (status) {
      if (status.err) {
        return { confirmed: false, reason: 'TRANSACTION_ERROR', err: status.err, slot: status.slot ?? null, signature };
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { confirmed: true, slot: status.slot ?? null, confirmationStatus: status.confirmationStatus, signature };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { confirmed: false, reason: 'CONFIRMATION_TIMEOUT', lastStatus, signature };
}

/* ------------------------------------------------- post-settlement proof -- */

/**
 * Hash the MESSAGE bytes of a serialized transaction.
 *
 * Wire format is: [compact-u16 signature count][64 bytes per signature][message].
 * Signatures are stripped, so the same message hashes identically before and
 * after signing. That is what lets us prove the wallet signed the exact
 * transaction we prepared rather than one substituted for it.
 *
 * Parsed by hand to keep this dependency-free and independent of any SDK's
 * transaction class.
 */
export function transactionMessageHash(base64Transaction) {
  const buf = Buffer.from(base64Transaction, 'base64');
  let count = 0;
  let size = 0;
  for (;;) {
    if (size >= buf.length) throw new Error('transactionMessageHash: truncated signature vector');
    const byte = buf[size];
    count |= (byte & 0x7f) << (size * 7);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size > 3) throw new Error('transactionMessageHash: invalid compact-u16');
  }
  const messageStart = size + count * 64;
  if (messageStart > buf.length) throw new Error('transactionMessageHash: truncated transaction');
  return createHash('sha256').update(buf.subarray(messageStart)).digest('hex');
}

/**
 * The exact change in an owner's balance of one mint, caused by ONE transaction.
 *
 * Read from that transaction's own pre/post token balance metadata, so it cannot
 * be confused with any other activity in the wallet. This is the difference
 * between "a swap happened around now" and "this transaction moved exactly this
 * much", which is what a receipt has to prove.
 */
export async function tokenDeltaFromTransaction({ signature, owner, mint }) {
  const tx = await rpc('getTransaction', [
    signature,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
  ]);
  if (!tx?.meta) return null;

  const sum = (rows) => (rows || [])
    .filter((b) => String(b?.owner ?? '') === owner && String(b?.mint ?? '') === mint)
    .reduce((acc, b) => acc + BigInt(String(b?.uiTokenAmount?.amount ?? '0')), 0n);

  const before = sum(tx.meta.preTokenBalances);
  const after = sum(tx.meta.postTokenBalances);
  return { before, after, delta: after - before, err: tx.meta.err ?? null };
}

/** Native SOL delta for a transaction, used when the source leg is not an SPL token. */
export async function solDeltaFromTransaction({ signature, owner }) {
  const tx = await rpc('getTransaction', [
    signature,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
  ]);
  if (!tx?.meta) return null;
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const index = keys.findIndex((k) => String(k?.pubkey ?? k) === owner);
  if (index === -1) return null;
  const before = BigInt(tx.meta.preBalances?.[index] ?? 0);
  const after = BigInt(tx.meta.postBalances?.[index] ?? 0);
  return { before, after, delta: after - before };
}
