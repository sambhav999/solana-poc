/**
 * Corporate-action classification.
 *
 * This is a SAFETY CONTROL, not metadata. The dividend maths applied to the
 * wrong event type will happily compute a "dividend" of 90% of a position.
 *
 * Values observed across all 832 Solana-deployed xStocks (September 2026):
 *   Dividend        583   multiplier rises by well under 1% typically
 *   Split             8   multiplier rises 2x - 10x   <- catastrophic if misread
 *   Administrative    3   corrections; direction varies
 *   ReverseSplit      2   multiplier falls ~50%
 *
 * Note the live API uses the string "Dividend". Earlier drafts of the Overflow
 * spec referred to ISO-style codes (DVCA / SPLF / SPLR); those do not appear in
 * the xStocks response and must not be matched on.
 *
 * The list is an ALLOWLIST so that any future event type fails closed.
 */

export const SUPPORTED_REASONS = ['Dividend'];

export const KNOWN_UNSUPPORTED_REASONS = {
  Split: 'Stock split: raises the multiplier without creating economic value.',
  ReverseSplit: 'Reverse split: lowers the multiplier.',
  Administrative: 'Administrative correction: not a distribution.',
};

export function classifyCorporateAction(event) {
  const reason = event && event.reason != null ? String(event.reason) : '';

  if (SUPPORTED_REASONS.includes(reason)) {
    return { supported: true, reason, eventType: 'DIVIDEND' };
  }
  if (Object.hasOwn(KNOWN_UNSUPPORTED_REASONS, reason)) {
    return {
      supported: false,
      reason,
      eventType: reason.toUpperCase(),
      detail: KNOWN_UNSUPPORTED_REASONS[reason],
    };
  }
  return {
    supported: false,
    reason: reason || '(none)',
    eventType: 'UNKNOWN',
    detail: 'Unrecognised corporate action type. Overflow fails closed on unknown events.',
  };
}

/**
 * xStocks activates multiplier changes at a scheduled time. Reading the
 * multiplier while it is being written can yield a torn value, so executions are
 * blocked in a window either side of activation.
 */
export const ACTIVATION_SAFETY_WINDOW_MS = 15 * 60 * 1000;

export function activationWindowState(activationDateTime, now = Date.now()) {
  const activationMs = new Date(activationDateTime).getTime();
  if (!Number.isFinite(activationMs)) {
    return { state: 'INVALID', safe: false, detail: `unparseable activation time: ${activationDateTime}` };
  }
  const delta = now - activationMs;
  if (delta < -ACTIVATION_SAFETY_WINDOW_MS) {
    return { state: 'PENDING', safe: false, activationMs, msUntilActivation: -delta };
  }
  if (Math.abs(delta) <= ACTIVATION_SAFETY_WINDOW_MS) {
    return { state: 'IN_SAFETY_WINDOW', safe: false, activationMs, msSinceActivation: delta };
  }
  return { state: 'ACTIVE', safe: true, activationMs, msSinceActivation: delta };
}
