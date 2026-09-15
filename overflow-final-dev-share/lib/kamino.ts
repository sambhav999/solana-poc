import Decimal from 'decimal.js';
import {
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { connection } from './solana';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function toDecimal(v: any): Decimal {
  if (v == null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(typeof v?.toString === 'function' ? v.toString() : String(v));
}
function rpcUrl() {
  return process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

async function currentKaminoContext(vaultAddress: string) {
  const sdk: any = await import('@kamino-finance/klend-sdk');
  const kit: any = await import('@solana/kit');
  const rpc = kit.createSolanaRpc(rpcUrl());
  // Current Kamino Earn docs construct KaminoVault with the RPC client + vault
  // address. Avoid relying on historical/internal constructor arguments.
  const vault = new sdk.KaminoVault(rpc, kit.address(vaultAddress));
  return { kit, rpc, vault };
}

export interface KaminoSnapshot {
  /** Whole vault shares, exactly as the current Kamino Earn SDK exposes them. */
  sharesAmount: string;
  /** Underlying USDC per whole share. */
  exchangeRate: string;
  tokenDecimals: number;
  redeemableUsd: string;
  apy: number | null;
  derivation: string;
  vaultTokenMint: string;
}

export async function getKaminoVaultSnapshot(vaultAddress: string, wallet: string): Promise<KaminoSnapshot> {
  const { vault, kit, rpc } = await currentKaminoContext(vaultAddress);
  const state: any = await vault.getState();
  const tokenMint = String(state?.tokenMint ?? state?.token_mint ?? '');
  if (tokenMint && tokenMint !== USDC_MINT) {
    throw new Error(`Configured Kamino vault is not USDC (underlying ${tokenMint})`);
  }

  const position: any = await vault.getUserShares(kit.address(wallet));
  const shares = toDecimal(position?.totalShares ?? position?.shares ?? position ?? 0);
  const slot = await rpc.getSlot().send();
  const exchangeRate = toDecimal(await vault.getExchangeRate(slot));
  if (exchangeRate.lte(0)) throw new Error('Invalid Kamino exchange rate');
  const redeemable = shares.mul(exchangeRate);

  let apy: number | null = null;
  try {
    const apys = await vault.getAPYs(slot);
    const n = Number(apys?.grossAPY ?? apys?.apy ?? apys?.netAPY ?? apys?.vaultApy);
    apy = Number.isFinite(n) ? n : null;
  } catch { apy = null; }

  return {
    sharesAmount: shares.toFixed(18),
    exchangeRate: exchangeRate.toFixed(18),
    tokenDecimals: 6,
    redeemableUsd: redeemable.toFixed(6),
    apy,
    derivation: `${shares.toFixed(12)} whole shares × ${exchangeRate.toFixed(12)} USDC/share`,
    vaultTokenMint: tokenMint || USDC_MINT,
  };
}

/** Convert a target USDC withdrawal to whole Kamino shares, biased down. */
export function sharesForWithdrawal(withdrawTokens: string | number, snapshot: KaminoSnapshot): Decimal {
  const rate = new Decimal(snapshot.exchangeRate);
  if (rate.lte(0)) throw new Error('Invalid Kamino exchange rate');
  const exact = new Decimal(withdrawTokens).div(rate);
  if (exact.lte(0)) return new Decimal(0);
  return Decimal.max(0, exact.sub('0.000000000001')).toDecimalPlaces(12, Decimal.ROUND_DOWN);
}

function kitInstructionToWeb3(ix: any): TransactionInstruction {
  if (ix?.programId && Array.isArray(ix?.keys)) return ix as TransactionInstruction;
  const program = ix?.programAddress ?? ix?.programId ?? ix?.program;
  if (!program) throw new Error('Kamino instruction missing program address');
  const keys = (ix?.accounts ?? ix?.keys ?? []).map((a: any) => {
    const role = a?.role;
    const roleText = String(role ?? '').toLowerCase();
    const numericRole = typeof role === 'number' ? role : -1;
    const addr = a?.address ?? a?.pubkey;
    if (!addr) throw new Error('Kamino instruction account missing address');
    return {
      pubkey: new PublicKey(String(addr)),
      isWritable: numericRole === 1 || numericRole === 3 || roleText.includes('writable'),
      isSigner: numericRole === 2 || numericRole === 3 || roleText.includes('signer'),
    };
  });
  return new TransactionInstruction({ programId: new PublicKey(String(program)), keys, data: Buffer.from(ix?.data ?? []) });
}

async function lookupTablesForState(state: any): Promise<AddressLookupTableAccount[]> {
  const raw = state?.vaultLookupTable ?? state?.vault_lookup_table;
  if (!raw) return [];
  const address = String(raw);
  if (!address || address === '11111111111111111111111111111111') return [];
  try {
    const { value } = await connection().getAddressLookupTable(new PublicKey(address));
    return value ? [value] : [];
  } catch { return []; }
}

/** Build, but never sign, the current Kamino Earn withdrawal transaction. */
export async function buildKaminoWithdrawTx(vaultAddress: string, wallet: string, sharesAmount: string): Promise<string> {
  const { kit, vault } = await currentKaminoContext(vaultAddress);
  const state: any = await vault.getState();
  const result: any = await vault.withdrawIxs(kit.createNoopSigner(kit.address(wallet)), new Decimal(sharesAmount));

  // Current SDK may include an unstake leg for farm-backed vault shares. It must
  // precede the actual withdrawal instructions.
  const rawIxs = Array.isArray(result)
    ? result
    : [
        ...(result?.unstakeFromFarmIfNeededIxs || []),
        ...(result?.withdrawIxs || result?.ixs || result?.instructions || []),
      ];
  if (!rawIxs.length) throw new Error('Kamino SDK returned no withdrawal instructions');

  const c = connection();
  const { blockhash } = await c.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: new PublicKey(wallet),
    recentBlockhash: blockhash,
    instructions: rawIxs.map(kitInstructionToWeb3),
  }).compileToV0Message(await lookupTablesForState(state));
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}
