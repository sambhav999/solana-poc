/**
 * Pyth Pro price reads, used by the PYTH_PARITY firewall mode to compare a
 * tokenized stock against the underlying equity.
 *
 * Requires PYTH_PRICE_API_URL and PYTH_API_KEY (Pyth Pro is a paid service).
 * When unconfigured, every read FAILS CLOSED: a firewall that cannot see a
 * reference price must not let the trade through.
 *
 * The response shape is taken from the V4.1 integration and has NOT been
 * verified against a live Pyth Pro account; confirm it before relying on it.
 */
export function pythConfigured() {
  return Boolean(process.env.PYTH_PRICE_API_URL && process.env.PYTH_API_KEY);
}

export async function pythPriceUsd(feed) {
  const base = (process.env.PYTH_PRICE_API_URL || '').replace(/\/$/, '');
  const key = process.env.PYTH_API_KEY;
  if (!base || !key) throw new Error('Pyth Pro is not configured (set PYTH_PRICE_API_URL and PYTH_API_KEY).');

  const res = await fetch(`${base}/v1/price/latest?symbol=${encodeURIComponent(feed)}`, {
    headers: { authorization: `Bearer ${key}`, 'x-api-key': key, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Pyth price request for ${feed} failed (${res.status})`);
  const body = await res.json();
  const value = body?.price ?? body?.data?.price ?? body?.parsed?.[0]?.price?.price;
  const expo = Number(body?.expo ?? body?.data?.expo ?? body?.parsed?.[0]?.price?.expo ?? 0);
  if (value == null || !Number.isInteger(expo)) throw new Error(`Pyth returned no usable price for ${feed}`);
  // Apply the exponent on the decimal string itself, never through a float.
  return shiftDecimal(String(value), expo);
}

function shiftDecimal(intString, expo) {
  const negative = intString.startsWith('-');
  const digits = intString.replace(/^-/, '').replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(digits)) throw new Error(`Pyth price is not an integer: ${intString}`);
  let out;
  if (expo >= 0) out = digits + '0'.repeat(expo);
  else {
    const places = -expo;
    const padded = digits.padStart(places + 1, '0');
    out = `${padded.slice(0, padded.length - places)}.${padded.slice(padded.length - places)}`;
  }
  if (negative) throw new Error('Pyth returned a negative price');
  return out;
}
