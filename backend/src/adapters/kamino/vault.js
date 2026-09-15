/**
 * Kamino Earn (KVault) adapter.
 *
 * Isolated behind this boundary so the rule engine never sees an SDK type. The
 * klend-sdk is loaded dynamically: the dividend rule -- the part of Overflow that
 * is actually novel -- must keep working whether or not the Kamino dependency is
 * installed or currently API-compatible.
 *
 * THE CRITICAL DETAIL: vault shares and USDC are not 1:1. A share appreciates
 * against USDC via the vault exchange rate. Withdrawing "the yield" means
 * converting a USDC amount into shares at the live rate and ROUNDING DOWN, which
 * core/principal.js does. Rounding up is the single most likely way this system
 * would ever spend principal.
 */

import { getTokenBalance, getSlot } from '../solana/rpc.js';
import { redeemableFromShares, USDC_DECIMALS } from '../../core/principal.js';
import { parseDecimalToScaled } from '../../core/units.js';

let sdkModule;
let sdkLoadError = null;

async function loadSdk() {
  if (sdkModule !== undefined) return sdkModule;
  try {
    sdkModule = await import('@kamino-finance/klend-sdk');
  } catch (err) {
    sdkLoadError = err.message;
    sdkModule = null;
  }
  return sdkModule;
}

export async function sdkStatus() {
  const sdk = await loadSdk();
  return {
    available: Boolean(sdk),
    error: sdkLoadError,
    hint: sdk ? null : 'npm install @kamino-finance/klend-sdk @solana/kit decimal.js to enable the interest rule',
  };
}

/**
 * Read a user's vault position.
 *
 * Returns normalized fields only:
 *   { available, sharesAtomic, shareDecimals, exchangeRateScaled, redeemableAtomic, apyPct, slot }
 *
 * `redeemableAtomic` is USDC atomic units (6dp) and is the ONLY figure the rule
 * engine consumes. It is never used to infer the principal floor.
 */
export async function readPosition({ owner, vaultAddress, shareMint }) {
  const sdk = await loadSdk();
  const slot = await getSlot().catch(() => null);

  if (!sdk) {
    // Degraded read: without the SDK we can still see the user's share balance,
    // but not the exchange rate, so redeemable value is unknown. We report that
    // honestly rather than guessing a rate.
    let shares = null;
    if (shareMint) {
      shares = await getTokenBalance({ owner, mint: shareMint }).catch(() => null);
    }
    return {
      available: false,
      reason: 'KAMINO_SDK_UNAVAILABLE',
      detail: sdkLoadError,
      sharesAtomic: shares?.rawAtomic ?? null,
      shareDecimals: shares?.decimals ?? null,
      exchangeRateScaled: null,
      redeemableAtomic: null,
      apyPct: null,
      slot,
    };
  }

  try {
    const { KaminoVault, KaminoManager } = sdk;
    const { createSolanaRpc, address } = await import('@solana/kit');
    const rpcClient = createSolanaRpc(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

    const vault = new KaminoVault(rpcClient, address(vaultAddress));
    const manager = new KaminoManager(rpcClient);

    // The SDK expects a BigInt slot; our RPC reader returns a Number.
    const slotBig = slot != null ? BigInt(slot) : undefined;
    const [exchangeRate, apys] = await Promise.all([
      vault.getExchangeRate(slotBig),
      vault.getAPYs(slotBig).catch(() => null),
    ]);

    // getUserSharesBalanceAllVaults returns UserSharesForVault objects
    // ({ unstakedShares, stakedShares, totalShares }), NOT a bare Decimal, and the
    // figures are in TOKENS rather than lamports.
    const balances = await manager.getUserSharesBalanceAllVaults(address(owner));
    let userShares = null;
    for (const [vaultKey, shares] of balances.entries()) {
      if (String(vaultKey) === String(vaultAddress)) { userShares = shares; break; }
    }

    const shareDecimals = Number(process.env.KAMINO_SHARE_DECIMALS || 6);
    const exchangeRateScaled = parseDecimalToScaled(String(exchangeRate));
    const sharesTokens = userShares ? String(userShares.totalShares ?? '0') : '0';
    const sharesAtomic = parseDecimalToScaled(sharesTokens) / 10n ** BigInt(18 - shareDecimals);

    const redeemableAtomic = redeemableFromShares({
      sharesAtomic,
      shareDecimals,
      exchangeRateScaled,
    });

    return {
      available: true,
      sharesAtomic: sharesAtomic.toString(),
      sharesTokens,
      stakedShares: userShares ? String(userShares.stakedShares ?? '0') : '0',
      unstakedShares: userShares ? String(userShares.unstakedShares ?? '0') : '0',
      shareDecimals,
      exchangeRateScaled: exchangeRateScaled.toString(),
      redeemableAtomic: redeemableAtomic.toString(),
      apyPct: apys ? String(apys.grossAPY ?? apys.netAPY ?? '') : null,
      slot,
      usdcDecimals: USDC_DECIMALS,
    };
  } catch (err) {
    // A live SDK that throws is a different failure from an absent one, and the
    // UI must be able to tell them apart.
    return {
      available: false,
      reason: 'KAMINO_READ_FAILED',
      detail: err.message,
      sharesAtomic: null,
      shareDecimals: null,
      exchangeRateScaled: null,
      redeemableAtomic: null,
      apyPct: null,
      slot,
    };
  }
}

/**
 * Withdrawal instructions for a given number of SHARES.
 *
 * The caller passes shares already floored by usdcToSharesFloor(); this function
 * deliberately performs no rounding of its own, so the one decision that could
 * overdraw principal stays in the audited core.
 *
 * The SDK takes shares in TOKENS (not lamports) and returns three ordered
 * groups. `unstakeFromFarmIfNeededIxs` MUST precede `withdrawIxs`.
 */
export async function buildWithdrawInstructions({ owner, vaultAddress, sharesAtomic, shareDecimals = 6 }) {
  const sdk = await loadSdk();
  if (!sdk) throw new Error('Kamino SDK unavailable; cannot build withdrawal instructions');
  const { KaminoVault } = sdk;
  const { createSolanaRpc, address, createNoopSigner } = await import('@solana/kit');
  const Decimal = (await import('decimal.js')).default;

  const rpcClient = createSolanaRpc(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
  const vault = new KaminoVault(rpcClient, address(vaultAddress));
  const slot = await getSlot();

  const sharesTokens = new Decimal(sharesAtomic.toString()).div(new Decimal(10).pow(shareDecimals));
  if (sharesTokens.lte(0)) throw new Error('share amount must be positive');

  const result = await vault.withdrawIxs(
    createNoopSigner(address(owner)),
    sharesTokens,
    BigInt(slot),
  );

  return {
    instructions: [
      ...(result.unstakeFromFarmIfNeededIxs ?? []),
      ...(result.withdrawIxs ?? []),
      ...(result.postWithdrawIxs ?? []),
    ],
    sharesTokens: sharesTokens.toString(),
    groups: {
      unstake: (result.unstakeFromFarmIfNeededIxs ?? []).length,
      withdraw: (result.withdrawIxs ?? []).length,
      post: (result.postWithdrawIxs ?? []).length,
    },
  };
}

/** Deposit instructions for a USDC amount, in tokens. */
export async function buildDepositInstructions({ owner, vaultAddress, usdcAtomic }) {
  const sdk = await loadSdk();
  if (!sdk) throw new Error('Kamino SDK unavailable; cannot build deposit instructions');
  const { KaminoVault, KaminoManager } = sdk;
  const { createSolanaRpc, address, createNoopSigner } = await import('@solana/kit');
  const Decimal = (await import('decimal.js')).default;

  const rpcClient = createSolanaRpc(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
  const vault = new KaminoVault(rpcClient, address(vaultAddress));
  const manager = new KaminoManager(rpcClient);

  const amountTokens = new Decimal(usdcAtomic.toString()).div(new Decimal(10).pow(USDC_DECIMALS));
  if (amountTokens.lte(0)) throw new Error('deposit amount must be positive');

  // farmState is an optional parameter that the SDK resolves itself when omitted.
  // (There is no loadVaultFarmState on KaminoManager in klend-sdk 7.x -- that name
  // came from an older example and throws a TypeError if called.)
  const state = await vault.getState();
  let reserves;
  try { reserves = await manager.loadVaultReserves(state); } catch { reserves = undefined; }

  const result = await vault.depositIxs(
    createNoopSigner(address(owner)),
    amountTokens,
    reserves,
  );

  return {
    instructions: [
      ...(result.depositIxs ?? []),
      ...(result.stakeInFarmIfNeededIxs ?? []),
      ...(result.stakeInFlcFarmIfNeededIxs ?? []),
    ],
    amountTokens: amountTokens.toString(),
    groups: {
      deposit: (result.depositIxs ?? []).length,
      stakeFarm: (result.stakeInFarmIfNeededIxs ?? []).length,
      stakeFlc: (result.stakeInFlcFarmIfNeededIxs ?? []).length,
    },
  };
}
