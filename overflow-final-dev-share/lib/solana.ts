import { createHash } from 'crypto';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export function connection() {
  const url =
    process.env.SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}

export class RpcUnavailable extends Error {
  constructor(message: string) {
    super(`RPC unavailable: ${message}`);
    this.name = 'RpcUnavailable';
  }
}

/**
 * Reads a raw Token-2022 / SPL balance.
 *
 * A missing token account is a legitimate zero. An RPC failure is not, and must
 * never be reported as a zero balance — that would silently turn an outage into
 * "no dividend exposure" and, on the interest path, into a wrong harvest size.
 */
export async function rawTokenBalance(
  owner: string,
  mint: string
): Promise<{ amount: bigint; decimals: number; ata: string; exists: boolean }> {
  const c = connection();
  const ownerPk = new PublicKey(owner);
  const mintPk = new PublicKey(mint);

  let lastRpcError: unknown = null;

  for (const program of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, false, program);
    try {
      const info = await c.getAccountInfo(ata, 'confirmed');
      if (!info) continue; // account genuinely absent under this program
      const bal = await c.getTokenAccountBalance(ata, 'confirmed');
      return {
        amount: BigInt(bal.value.amount),
        decimals: bal.value.decimals,
        ata: ata.toBase58(),
        exists: true
      };
    } catch (e) {
      lastRpcError = e;
    }
  }

  if (lastRpcError) throw new RpcUnavailable(String((lastRpcError as Error)?.message ?? lastRpcError));

  // Both programs answered and neither account exists.
  const mintInfo = await c.getParsedAccountInfo(mintPk, 'confirmed');
  const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals;
  if (typeof decimals !== 'number') throw new RpcUnavailable(`could not read decimals for mint ${mint}`);
  return { amount: 0n, decimals, ata: '', exists: false };
}

export function txFromBase64(b64: string) {
  return VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
}
export function txToBase64(tx: VersionedTransaction) {
  return Buffer.from(tx.serialize()).toString('base64');
}

/**
 * Hash only the versioned transaction message (not signatures). This lets the
 * server bind a wallet-signed transaction to the exact Jupiter order it issued.
 * Signing changes signatures, never message bytes.
 */
export function transactionMessageHash(base64Transaction: string): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Transaction, 'base64'));
  return createHash('sha256').update(Buffer.from(tx.message.serialize())).digest('hex');
}

export async function confirmSignature(signature: string) {
  const c = connection();
  const result = await c.getSignatureStatus(signature, { searchTransactionHistory: true });
  return {
    confirmed: Boolean(result.value && !result.value.err),
    error: result.value?.err ?? null,
    slot: result.value?.slot ?? null
  };
}

/** Polls until the tx is confirmed or the deadline passes. Used before verification. */
export async function awaitConfirmation(signature: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = await confirmSignature(signature);
  while (!last.confirmed && !last.error && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    last = await confirmSignature(signature);
  }
  return last;
}

/**
 * Exact raw token delta attributable to one confirmed transaction, using Solana
 * transaction metadata rather than a before/after wallet snapshot that could be
 * polluted by unrelated transfers between reads.
 */
export async function tokenDeltaFromTransaction(
  signature: string,
  owner: string,
  mint: string
): Promise<{ delta: bigint; before: bigint; after: bigint } | null> {
  const c = connection();
  const tx = await c.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) return null;

  const sum = (rows: readonly any[] | null | undefined) =>
    (rows || [])
      .filter((b: any) => String(b?.owner || '') === owner && String(b?.mint || '') === mint)
      .reduce((acc: bigint, b: any) => acc + BigInt(String(b?.uiTokenAmount?.amount || '0')), 0n);

  const before = sum(tx.meta.preTokenBalances);
  const after = sum(tx.meta.postTokenBalances);
  return { before, after, delta: after - before };
}
