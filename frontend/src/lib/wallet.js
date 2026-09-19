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
import { tagError, trace, traceError } from './trace.js';

const FEATURE_CONNECT = 'standard:connect';
const FEATURE_DISCONNECT = 'standard:disconnect';
const FEATURE_SIGN_TX = 'solana:signTransaction';
const FEATURE_SIGN_AND_SEND = 'solana:signAndSendTransaction';
const FEATURE_SIGN_MESSAGE = 'solana:signMessage';

export function solanaChain() {
  return import.meta.env.VITE_SOLANA_CLUSTER === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
}

export const PHANTOM_CONNECT_EVENT = 'overflow:connect-phantom';
export function requestPhantomConnect() {
  window.dispatchEvent(new CustomEvent(PHANTOM_CONNECT_EVENT));
}

function isPhantomName(name) {
  return /phantom/i.test(String(name || ''));
}

function isSolanaWallet(wallet) {
  const chains = wallet.chains || [];
  if (!chains.length) return true;
  return chains.some((chain) => String(chain).startsWith('solana:'));
}

function listStandardPhantoms() {
  const { get } = getWallets();
  return get().filter(
    (wallet) =>
      isPhantomName(wallet.name) &&
      isSolanaWallet(wallet) &&
      wallet.features?.[FEATURE_CONNECT],
  );
}

function injectedProviders() {
  if (typeof window === 'undefined') return [];
  const seen = new Set();
  const out = [];
  for (const [label, provider] of [
    ['phantom.solana', window.phantom?.solana],
    ['window.solana', window.solana],
  ]) {
    if (!provider?.isPhantom || seen.has(provider)) continue;
    seen.add(provider);
    out.push({ label, provider });
  }
  return out;
}

export function getInjectedPhantom() {
  return injectedProviders()[0]?.provider || null;
}

function accountFromPublicKey(pk) {
  if (!pk) return [];
  const address = typeof pk === 'string' ? pk : (pk.toBase58?.() || pk.toString());
  return address ? [{ address }] : [];
}

function safePublicKey(provider) {
  try { return provider?.publicKey || null; } catch { return null; }
}

function fromPublicKey(pk, wallet) {
  const accounts = accountFromPublicKey(pk);
  if (!accounts.length) return null;
  return { wallet, account: accounts[0], address: accounts[0].address };
}

function fromProvider(provider) {
  return fromPublicKey(safePublicKey(provider), wrapInjectedPhantom(provider));
}

function fromStandardWallet(wallet) {
  const account = wallet?.accounts?.[0];
  if (!account?.address) return null;
  return { wallet, account, address: account.address };
}

function isUserReject(err) {
  const code = err?.code;
  const message = String(err?.message || '');
  return code === 4001 || /reject|denied|cancel/i.test(message);
}

function isInternalConnectError(err) {
  return err?.code === -32603 || /^unexpected error$/i.test(String(err?.message || ''));
}

export function explainPhantomConnectError(err) {
  if (isUserReject(err)) return null;
  if (isInternalConnectError(err)) {
    return {
      title: 'Phantom could not connect',
      message: 'Phantom crashed inside sol_connect and hid the real reason as Unexpected error (code -32603). Overflow never reached the API.',
      hint: 'Phantom hid the real crash behind that code. Unlock Phantom, select a Solana account, reload this tab, and try once. On workers.dev use Open in Phantom or localhost. The real line is in Phantom’s service worker console: RPC ROUTER Unexpected error in method sol_connect.',
    };
  }
  return null;
}

function wrapInjectedPhantom(provider) {
  return {
    name: 'Phantom',
    chains: [solanaChain()],
    provider,
    features: {
      [FEATURE_CONNECT]: {
        connect: async () => {
          const existing = accountFromPublicKey(safePublicKey(provider));
          if (existing.length) return { accounts: existing };
          const result = await provider.connect();
          const accounts = accountFromPublicKey(result?.publicKey || safePublicKey(provider));
          if (!accounts.length) throw new Error('Phantom connected but exposed no account.');
          return { accounts };
        },
      },
      [FEATURE_DISCONNECT]: {
        disconnect: async () => {
          try { await provider.disconnect(); } catch { /* optional */ }
        },
      },
      [FEATURE_SIGN_MESSAGE]: {
        signMessage: async ({ message }) => {
          const out = await provider.signMessage(message, 'utf8');
          const signature = out?.signature || out;
          const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
          return [{ signature: bytes }];
        },
      },
      [FEATURE_SIGN_TX]: {
        signTransaction: async ({ transaction }) => {
          const signed = await signInjectedTransaction(provider, transaction);
          return [{ signedTransaction: signed }];
        },
      },
    },
  };
}

export function listSolanaWallets() {
  const standard = listStandardPhantoms();
  if (standard.length) return standard;
  const injected = getInjectedPhantom();
  return injected ? [wrapInjectedPhantom(injected)] : [];
}

function reuseExistingSession() {
  for (const { label, provider } of injectedProviders()) {
    const connected = fromProvider(provider);
    if (connected) {
      trace('phantom:reuse-injected', { label, address: connected.address, isConnected: provider.isConnected });
      return connected;
    }
  }
  for (const wallet of listStandardPhantoms()) {
    const connected = fromStandardWallet(wallet);
    if (connected) {
      trace('phantom:reuse-standard', { name: wallet.name, address: connected.address });
      return connected;
    }
  }
  return null;
}

function recoverAfterFail(provider, err, label) {
  const connected = fromProvider(provider);
  if (connected) {
    trace('phantom:recovered-after-throw', { label, address: connected.address, code: err?.code });
    return connected;
  }
  return null;
}

async function connectInjected(provider, label) {
  const existing = fromProvider(provider);
  if (existing) {
    trace('phantom:already-connected', { label, address: existing.address });
    return existing;
  }

  trace('phantom:injected:attempt', { label, name: 'connect()' });
  try {
    const result = await provider.connect();
    const connected = fromPublicKey(result?.publicKey || safePublicKey(provider), wrapInjectedPhantom(provider));
    if (!connected) throw new Error('Phantom connected but exposed no account.');
    trace('phantom:injected:ok', { label, address: connected.address });
    return connected;
  } catch (err) {
    traceError(`phantom:injected:fail:${label}:connect()`, err);
    const recovered = recoverAfterFail(provider, err, `${label}:connect()`);
    if (recovered) return recovered;
    throw err;
  }
}

async function connectStandard(wallet) {
  const existing = fromStandardWallet(wallet);
  if (existing) return existing;
  const connect = wallet.features[FEATURE_CONNECT]?.connect;
  if (!connect) return null;
  trace('phantom:connect:standard:start', { name: wallet.name, features: Object.keys(wallet.features || {}) });
  try {
    const result = await connect();
    const account = result?.accounts?.[0] ?? wallet.accounts?.[0];
    if (!account) throw new Error('Wallet connected but exposed no account.');
    trace('phantom:connect:standard:ok', { address: account.address });
    return { wallet, account, address: account.address };
  } catch (err) {
    traceError('phantom:connect:standard:fail', err);
    const recovered = fromStandardWallet(wallet);
    if (recovered) return recovered;
    throw err;
  }
}

export function onWalletsChanged(callback) {
  const { on } = getWallets();
  const offRegister = on('register', callback);
  const offUnregister = on('unregister', callback);
  return () => { offRegister(); offUnregister(); };
}

function missingPhantom() {
  const err = tagError(new Error('PHANTOM_MISSING'), { stage: 'wallet-connect', source: 'phantom' });
  err.code = 'PHANTOM_MISSING';
  return err;
}

/**
 * User-gesture connect. Reuse an existing Phantom session first; calling
 * connect() again while a publicKey is already present is a common -32603.
 * Interactive connect uses provider.connect(), then request({ method: 'connect' }).
 */
export async function connectPhantom() {
  const providers = injectedProviders();
  const standard = listStandardPhantoms();
  trace('phantom:detect', {
    injected: providers.map((p) => p.label),
    injectedPublicKey: safePublicKey(providers[0]?.provider)?.toString?.() || null,
    standardCount: standard.length,
    standardNames: standard.map((w) => w.name),
    accountCount: standard.map((w) => w.accounts?.length || 0),
    hasWindowPhantom: typeof window !== 'undefined' && Boolean(window.phantom),
    hasWindowSolana: typeof window !== 'undefined' && Boolean(window.solana),
  });

  const reused = reuseExistingSession();
  if (reused) return reused;

  if (!providers.length && !standard.length) {
    const err = missingPhantom();
    traceError('phantom:connect:missing', err);
    throw err;
  }

  let lastErr = null;
  for (const { label, provider } of providers) {
    try {
      return await connectInjected(provider, label);
    } catch (err) {
      lastErr = err;
      if (isUserReject(err) || err?.code === -32002 || isInternalConnectError(err)) {
        throw tagError(err, { stage: 'wallet-connect', source: 'phantom' });
      }
    }
  }
  for (const wallet of standard) {
    try {
      const connected = await connectStandard(wallet);
      if (connected) return connected;
    } catch (err) {
      lastErr = err;
      if (isUserReject(err)) throw tagError(err, { stage: 'wallet-connect', source: 'phantom' });
    }
  }
  throw tagError(lastErr || missingPhantom(), { stage: 'wallet-connect', source: 'phantom' });
}

export async function connectWallet(wallet) {
  if (!wallet) return connectPhantom();
  if (wallet.provider) return connectInjected(wallet.provider, 'wallet.provider');
  const connected = await connectStandard(wallet);
  if (connected) return connected;
  return connectPhantom();
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
    chain: solanaChain(),
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

async function signInjectedTransaction(provider, transactionBytes) {
  const bytes = transactionBytes instanceof Uint8Array
    ? transactionBytes
    : new Uint8Array(transactionBytes);

  if (typeof provider.signTransaction === 'function') {
    try {
      const { VersionedTransaction } = await import('@solana/web3.js');
      const tx = VersionedTransaction.deserialize(bytes);
      const signed = await provider.signTransaction(tx);
      const serialized = signed.serialize();
      return serialized instanceof Uint8Array ? serialized : new Uint8Array(serialized);
    } catch (err) {
      traceError('phantom:signTransaction:web3', err);
    }
  }

  if (typeof provider.request === 'function') {
    const out = await provider.request({
      method: 'signTransaction',
      params: { message: bytesToBase64(bytes), encoding: 'base64' },
    });
    const raw = out?.signedTransaction || out?.transaction || out;
    if (typeof raw === 'string') return base64ToBytes(raw);
    if (raw instanceof Uint8Array) return raw;
    if (raw) return new Uint8Array(raw);
  }

  throw new Error('Phantom could not sign this transaction. Reconnect the wallet and try again.');
}
