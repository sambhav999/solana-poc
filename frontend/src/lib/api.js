import { tagError, trace, traceError } from './trace.js';

/**
 * Backend client. The browser never talks to Jupiter, xStocks or an RPC
 * directly: every call goes through the Overflow API, which holds the keys.
 *
 * VITE_API_BASE is inlined from frontend/.env at Vite startup. Editing .env
 * requires restarting `npm run dev` or rebuilding.
 */
function resolveApiBase() {
  const raw = String(import.meta.env.VITE_API_BASE || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\/$/, '');
  if (raw) return raw;
  return 'https://solana-poc.onrender.com/api';
}

const BASE = resolveApiBase();
trace('api:base', { BASE });

/*
 * Session token from wallet sign-in. Kept in sessionStorage so a reload keeps
 * you signed in, but closing the tab ends it. Keyed by wallet so switching
 * wallets can never reuse another wallet's session.
 */
let session = null; // { wallet, token, expiresAt }
const storageKey = (wallet) => `overflow.session.${wallet}`;
const onAuthLost = new Set();

export function setSession(s) {
  session = s;
  try {
    if (s) sessionStorage.setItem(storageKey(s.wallet), JSON.stringify(s));
  } catch { /* storage unavailable: session lives in memory only */ }
}

export function restoreSession(wallet) {
  try {
    const raw = sessionStorage.getItem(storageKey(wallet));
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.token || new Date(s.expiresAt).getTime() <= Date.now()) return null;
    session = s;
    return s;
  } catch { return null; }
}

export function clearSession(wallet) {
  try { if (wallet) sessionStorage.removeItem(storageKey(wallet)); } catch { /* ignore */ }
  session = null;
}

export function currentSession() { return session; }
export function onSessionLost(fn) { onAuthLost.add(fn); return () => onAuthLost.delete(fn); }

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const method = options.method || 'GET';
  trace('api:request', { method, url, path, hasSession: Boolean(session?.token) });
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'content-type': 'application/json',
        ...(session?.token ? { authorization: `Bearer ${session.token}` } : {}),
        ...(options.headers || {}),
      },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    traceError('api:network-fail', err);
    throw tagError(err, { stage: `api:${path}`, source: 'api' });
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 300) }; }
  trace('api:response', { method, path, status: res.status, ok: res.ok, body });
  // An expired or rejected session: drop it and let the app ask to sign in again.
  if (res.status === 401 && session && !path.startsWith('/auth/')) {
    const lost = session.wallet;
    clearSession(lost);
    onAuthLost.forEach((fn) => fn(lost));
  }
  if (!res.ok) {
    const err = new Error(body.error || body.detail || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    traceError('api:http-fail', err);
    throw tagError(err, { stage: `api:${path}`, source: 'api' });
  }
  return body;
}

export const api = {
  health: () => request('/health'),
  destinations: () => request('/assets/destinations'),
  asset: (symbol) => request(`/assets/${encodeURIComponent(symbol)}`),
  sourceRoutable: (symbol) => request(`/assets/${encodeURIComponent(symbol)}/routable`),

  // Wallet sign-in.
  authNonce: (wallet) => request('/auth/nonce', { method: 'POST', body: { wallet } }),
  authVerify: (wallet, nonce, signature) => request('/auth/verify', { method: 'POST', body: { wallet, nonce, signature } }),

  // Scoped to the signed-in wallet by the server; no wallet is ever sent.
  listRules: () => request('/rules'),
  createRule: (rule) => request('/rules', { method: 'POST', body: rule }),
  submitRuleOnchain: (id, payload) => request(`/rules/${id}/onchain/submit`, { method: 'POST', body: payload }),
  prepareRuleOnchain: (id) => request(`/rules/${id}/onchain/prepare`, { method: 'POST', body: {} }),
  getRule: (id) => request(`/rules/${id}`),
  updateRule: (id, patch) => request(`/rules/${id}`, { method: 'PATCH', body: patch }),
  deleteRule: (id) => request(`/rules/${id}`, { method: 'DELETE' }),
  evaluate: (id) => request(`/rules/${id}/evaluate`),

  prepare: (id) => request(`/rules/${id}/prepare`, { method: 'POST', body: {} }),
  submit: (id, payload) => request(`/rules/${id}/submit`, { method: 'POST', body: payload }),
  submitReceiptOnchain: (id, receiptId, payload) => request(`/rules/${id}/receipts/${receiptId}/onchain/submit`, { method: 'POST', body: payload }),
  prepareReceiptOnchain: (id, receiptId) => request(`/rules/${id}/receipts/${receiptId}/onchain/prepare`, { method: 'POST', body: {} }),

  // Kamino money movement. Each is prepare -> wallet signs -> submit.
  deposit: (id, usdcAtomic) => request(`/rules/${id}/deposit`, { method: 'POST', body: { usdcAtomic } }),
  depositSubmit: (id, payload) => request(`/rules/${id}/deposit/submit`, { method: 'POST', body: payload }),
  harvestWithdrawSubmit: (id, payload) => request(`/rules/${id}/harvest/withdraw/submit`, { method: 'POST', body: payload }),
  withdrawPrincipal: (id, requestedAtomic) => request(`/rules/${id}/withdraw-principal`, { method: 'POST', body: { requestedAtomic } }),
  withdrawPrincipalSubmit: (id, payload) => request(`/rules/${id}/withdraw-principal/submit`, { method: 'POST', body: payload }),
  pendingFunds: (id) => request(`/rules/${id}/pending-funds`),
  reconfirmBaseline: (id) => request(`/rules/${id}/reconfirm-baseline`, { method: 'POST', body: {} }),

  receipts: () => request('/receipts'),
  transactions: () => request('/transactions'),
  decisions: () => request('/decisions'),
  portfolio: () => request('/portfolio'),
  preview: (id) => request(`/rules/${id}/preview`, { method: 'POST', body: {} }),

  replayEvents: (symbol) => request(`/replay/${encodeURIComponent(symbol)}/events`),
  replay: (symbol, body) => request(`/replay/${encodeURIComponent(symbol)}`, { method: 'POST', body }),

  walletOverview: (address) => request(`/wallet/${address}/overview`),
  tokenBalance: (address, mint) => request(`/wallet/${address}/token/${mint}`),

  poll: () => request('/poll', { method: 'POST', body: {} }),
};
