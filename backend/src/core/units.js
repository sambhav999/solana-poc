/**
 * Exact fixed-point arithmetic on BigInt.
 *
 * Every quantity that can reach a transaction is an integer here. Token amounts
 * are raw atomic units. Multipliers and USD values are integers scaled by
 * 10**SCALE_DECIMALS. There is no JS float anywhere in this module, and nothing
 * downstream of it may reintroduce one.
 *
 * Why this matters for Overflow specifically: the xStocks multiplier arrives as
 * a JSON number with ~17 significant digits (e.g. 1.0216625054701978), which is
 * already at the edge of IEEE-754 double precision. Parsing it through Number
 * and back loses the guarantee we need to prove source preservation, so we
 * capture the literal digits as a string and scale them to an integer.
 */

export const SCALE_DECIMALS = 18;
export const SCALE = 10n ** BigInt(SCALE_DECIMALS);

/**
 * Parse a decimal literal into an integer scaled by 10**scaleDecimals.
 * Accepts strings (preferred), numbers, and exponent notation.
 * Truncates toward zero beyond the scale; it never rounds up, because every
 * rounding decision in this codebase must be deliberate and directional.
 */
export function parseDecimalToScaled(value, scaleDecimals = SCALE_DECIMALS) {
  if (typeof value === 'bigint') return value * 10n ** BigInt(scaleDecimals);
  let str = typeof value === 'string' ? value.trim() : String(value);
  if (!str.length) throw new Error('parseDecimalToScaled: empty value');

  let negative = false;
  if (str.startsWith('-')) { negative = true; str = str.slice(1); }
  else if (str.startsWith('+')) str = str.slice(1);

  // Expand exponent notation without going through Number.
  const eIndex = str.search(/[eE]/);
  if (eIndex !== -1) {
    const mantissa = str.slice(0, eIndex);
    const exponent = Number(str.slice(eIndex + 1));
    if (!Number.isInteger(exponent)) throw new Error(`parseDecimalToScaled: bad exponent in "${value}"`);
    str = shiftDecimalString(mantissa, exponent);
  }

  if (!/^\d*\.?\d*$/.test(str) || str === '.' || str === '') {
    throw new Error(`parseDecimalToScaled: not a decimal literal: "${value}"`);
  }

  const [intPart = '0', fracPart = ''] = str.split('.');
  const frac = fracPart.slice(0, scaleDecimals).padEnd(scaleDecimals, '0');
  const scaled = BigInt(intPart || '0') * 10n ** BigInt(scaleDecimals) + BigInt(frac || '0');
  return negative ? -scaled : scaled;
}

/** Move the decimal point of a numeric string by `places` without using Number. */
function shiftDecimalString(str, places) {
  let [intPart = '0', fracPart = ''] = str.split('.');
  if (places === 0) return `${intPart}.${fracPart}`;
  if (places > 0) {
    const move = Math.min(places, fracPart.length);
    intPart += fracPart.slice(0, move);
    fracPart = fracPart.slice(move);
    intPart += '0'.repeat(places - move);
  } else {
    const move = Math.min(-places, intPart.length);
    fracPart = intPart.slice(intPart.length - move) + fracPart;
    intPart = intPart.slice(0, intPart.length - move);
    fracPart = '0'.repeat(-places - move) + fracPart;
  }
  return `${intPart || '0'}.${fracPart}`;
}

/** Render a scaled integer as a decimal string with `displayDecimals` places (truncating). */
export function formatScaled(scaled, displayDecimals = 6, scaleDecimals = SCALE_DECIMALS) {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const divisor = 10n ** BigInt(scaleDecimals);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(scaleDecimals, '0').slice(0, displayDecimals);
  const body = displayDecimals > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Raw atomic token amount -> scaled decimal integer, given the mint's decimals. */
export function rawToScaled(rawAtomic, tokenDecimals, scaleDecimals = SCALE_DECIMALS) {
  const raw = BigInt(rawAtomic);
  if (scaleDecimals < tokenDecimals) throw new Error('rawToScaled: scale too small for token decimals');
  return raw * 10n ** BigInt(scaleDecimals - tokenDecimals);
}

/** Scaled decimal integer -> raw atomic token amount, truncating toward zero. */
export function scaledToRaw(scaled, tokenDecimals, scaleDecimals = SCALE_DECIMALS) {
  if (scaleDecimals < tokenDecimals) throw new Error('scaledToRaw: scale too small for token decimals');
  return BigInt(scaled) / 10n ** BigInt(scaleDecimals - tokenDecimals);
}

/** Multiply two scaled integers, returning a scaled integer (truncating). */
export function mulScaled(a, b, scaleDecimals = SCALE_DECIMALS) {
  return (BigInt(a) * BigInt(b)) / 10n ** BigInt(scaleDecimals);
}

/** Divide two scaled integers, returning a scaled integer (truncating). */
export function divScaled(a, b, scaleDecimals = SCALE_DECIMALS) {
  if (BigInt(b) === 0n) throw new Error('divScaled: division by zero');
  return (BigInt(a) * 10n ** BigInt(scaleDecimals)) / BigInt(b);
}

export const maxBig = (a, b) => (a > b ? a : b);
export const minBig = (a, b) => (a < b ? a : b);

/**
 * Pull the exact digit sequence of a numeric field out of a raw JSON body.
 * JSON.parse would coerce it to a double first; this preserves the literal the
 * server actually sent so the multiplier we store is the multiplier we were given.
 */
export function extractRawJsonNumber(jsonText, field) {
  const m = new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`).exec(jsonText);
  return m ? m[1] : null;
}
