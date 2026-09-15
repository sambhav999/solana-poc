/**
 * Backend client. The browser never talks to Jupiter, xStocks or an RPC
 * directly: every call goes through the Overflow API, which holds the keys.
 */
const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8787/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(body.error || body.detail || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  health: () => request('/health'),
  destinations: () => request('/assets/destinations'),
  asset: (symbol) => request(`/assets/${encodeURIComponent(symbol)}`),
  sourceRoutable: (symbol) => request(`/assets/${encodeURIComponent(symbol)}/routable`),

  listRules: (wallet) => request(`/rules?wallet=${encodeURIComponent(wallet)}`),
  createRule: (rule) => request('/rules', { method: 'POST', body: rule }),
  getRule: (id) => request(`/rules/${id}`),
  updateRule: (id, patch) => request(`/rules/${id}`, { method: 'PATCH', body: patch }),
  deleteRule: (id) => request(`/rules/${id}`, { method: 'DELETE' }),
  evaluate: (id) => request(`/rules/${id}/evaluate`),

  prepare: (id) => request(`/rules/${id}/prepare`, { method: 'POST', body: {} }),
  submit: (id, payload) => request(`/rules/${id}/submit`, { method: 'POST', body: payload }),

  // Kamino money movement. Each is prepare -> wallet signs -> submit.
  deposit: (id, usdcAtomic) => request(`/rules/${id}/deposit`, { method: 'POST', body: { usdcAtomic } }),
  depositSubmit: (id, payload) => request(`/rules/${id}/deposit/submit`, { method: 'POST', body: payload }),
  harvestWithdrawSubmit: (id, payload) => request(`/rules/${id}/harvest/withdraw/submit`, { method: 'POST', body: payload }),
  withdrawPrincipal: (id, requestedAtomic) => request(`/rules/${id}/withdraw-principal`, { method: 'POST', body: { requestedAtomic } }),
  withdrawPrincipalSubmit: (id, payload) => request(`/rules/${id}/withdraw-principal/submit`, { method: 'POST', body: payload }),
  pendingFunds: (id) => request(`/rules/${id}/pending-funds`),
  reconfirmBaseline: (id) => request(`/rules/${id}/reconfirm-baseline`, { method: 'POST', body: {} }),

  receipts: (wallet) => request(`/receipts?wallet=${encodeURIComponent(wallet)}`),

  replayEvents: (symbol) => request(`/replay/${encodeURIComponent(symbol)}/events`),
  replay: (symbol, body) => request(`/replay/${encodeURIComponent(symbol)}`, { method: 'POST', body }),

  walletOverview: (address) => request(`/wallet/${address}/overview`),
  tokenBalance: (address, mint) => request(`/wallet/${address}/token/${mint}`),

  poll: () => request('/poll', { method: 'POST', body: {} }),
};
