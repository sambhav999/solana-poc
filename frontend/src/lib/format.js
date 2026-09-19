/**
 * Display helpers.
 *
 * Formatting NEVER touches a value on its way to a transaction. Every function
 * here takes an exact string from the backend and produces something for a human
 * to read; nothing converts back.
 */

/** Raw atomic units -> human decimal string, without going through Number. */
export function formatRaw(rawAtomic, decimals, displayDecimals = decimals) {
  if (rawAtomic === null || rawAtomic === undefined) return '-';
  const negative = String(rawAtomic).startsWith('-');
  const digits = String(rawAtomic).replace('-', '').padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const frac = digits.slice(digits.length - decimals).slice(0, displayDecimals);
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = displayDecimals > 0 ? `${withCommas}.${frac}` : withCommas;
  return negative ? `-${body}` : body;
}

/** USDC atomic (6dp) -> "$1,234.56" */
export function formatUsd(atomic, displayDecimals = 2) {
  if (atomic === null || atomic === undefined) return '-';
  return `$${formatRaw(atomic, 6, displayDecimals)}`;
}

/** Scaled 1e18 integer -> decimal string. */
export function formatScaled(scaled, displayDecimals = 8) {
  return formatRaw(scaled, 18, displayDecimals);
}

export function shortAddress(address, size = 4) {
  if (!address) return '';
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}

export function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatRelative(iso) {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  if (mins < 60) return ms > 0 ? `in ${mins} min` : `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return ms > 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return ms > 0 ? `in ${days}d` : `${days}d ago`;
}

export function pctFromDecimalString(s, places = 4) {
  if (s === null || s === undefined) return '-';
  const n = Number(s);
  if (!Number.isFinite(n)) return String(s);
  return `${n.toFixed(places)}%`;
}

export const explorerUrl = (signature) => {
  if (!signature) return '';
  const base = (import.meta.env.VITE_EXPLORER_BASE || 'https://solscan.io/tx').replace(/\/$/, '');
  const url = `${base}/${signature}`;
  if (import.meta.env.VITE_SOLANA_CLUSTER === 'devnet' && url.includes('solscan.io')) {
    return `${url}?cluster=devnet`;
  }
  return url;
};
