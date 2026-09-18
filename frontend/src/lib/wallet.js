/**
 * Wallet Standard connection and signing.
 *
 * Uses Wallet Standard discovery rather than the older wallet-adapter stack, so
 * any conforming wallet registers itself without Overflow enumerating brands.
 *
 * Signing operates on raw transaction BYTES. Jupiter hands us a base64
 * transaction, we decode it, the wallet signs the bytes, we re-encode and send
 * it back for submission. Nothing here needs a Solana SDK, and no key material
 * ever reaches Overflow.
 */
import { getWallets } from '@wallet-standard/app';

const SOLANA_MAINNET = 'solana:mainnet';
const FEATURE_CONNECT = 'standard:connect';
const FEATURE_DISCONNECT = 'standard:disconnect';
const FEATURE_SIGN_TX = 'solana:signTransaction';
const FEATURE_SIGN_AND_SEND = 'solana:signAndSendTransaction';
const FEATURE_SIGN_MESSAGE = 'solana:signMessage';

// Solana-only for now: Phantom is the only wallet this app connects to.
const SUPPORTED_WALLETS = ['Phantom'];

export function listSolanaWallets() {
  const { get } = getWallets();
  return get().filter(
    (w) =>
      SUPPORTED_WALLETS.includes(w.name) &&
      w.chains?.includes(SOLANA_MAINNET) &&
      w.features?.[FEATURE_CONNECT] &&
      w.features?.[FEATURE_SIGN_TX],
  );
}

export function onWalletsChanged(callback) {
  const { on } = getWallets();
  const offRegister = on('register', callback);
  const offUnregister = on('unregister', callback);
  return () => { offRegister(); offUnregister(); };
}

export async function connectWallet(wallet) {
  const result = await wallet.features[FEATURE_CONNECT].connect();
  const account = result.accounts?.[0] ?? wallet.accounts?.[0];
  if (!account) throw new Error('Wallet connected but exposed no account.');
  return { wallet, account, address: account.address };
}

export async function disconnectWallet(wallet) {
  try { await wallet.features?.[FEATURE_DISCONNECT]?.disconnect(); } catch { /* optional feature */ }
}

/**
 * Sign a base64 transaction and return it base64-encoded.
 * The transaction is built by Jupiter and reviewed by the user before this runs.
 */
export async function signTransactionBase64({ wallet, account, transactionBase64 }) {
  const feature = wallet.features[FEATURE_SIGN_TX];
  if (!feature) throw new Error('This wallet cannot sign transactions.');
  const bytes = base64ToBytes(transactionBase64);
  const [output] = await feature.signTransaction({
    account,
    chain: SOLANA_MAINNET,
    transaction: bytes,
  });
  if (!output?.signedTransaction) throw new Error('Wallet returned no signed transaction.');
  return bytesToBase64(output.signedTransaction);
}

export function supportsSignMessage(wallet) {
  return Boolean(wallet?.features?.[FEATURE_SIGN_MESSAGE]);
}

/**
 * Sign an off-chain message, used for sign-in. The message says in plain words
 * that it authorises no transaction and moves no funds; it is shown to the user
 * by their wallet before they approve it.
 */
export async function signMessageBase64({ wallet, account, message }) {
  const feature = wallet.features[FEATURE_SIGN_MESSAGE];
  if (!feature) throw new Error(`${wallet.name} cannot sign messages, so it cannot sign in.`);
  const [output] = await feature.signMessage({ account, message: new TextEncoder().encode(message) });
  if (!output?.signature) throw new Error('Wallet returned no signature.');
  return bytesToBase64(output.signature);
}

export function supportsSignAndSend(wallet) {
  return Boolean(wallet?.features?.[FEATURE_SIGN_AND_SEND]);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000; // avoid blowing the argument limit on large transactions
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
