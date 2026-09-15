/**
 * Jupiter Swap V2 adapter: /order -> user signs -> /execute.
 *
 * Verified against the live API (September 2026). An API key is optional for
 * prototyping but rate limits are tight without one; when JUPITER_API_KEY is set
 * it is sent as x-api-key. The key lives only here, server-side. The browser
 * never sees it -- it talks to this backend, which proxies.
 *
 * Order response fields we rely on:
 *   inAmount, outAmount, otherAmountThreshold  raw atomic strings
 *   priceImpactPct                             decimal percent string
 *   slippageBps                                number
 *   requestId                                  required by /execute
 *   transaction                                base64 tx; null when no taker given
 *   inUsdValue / outUsdValue                   USD valuation of the legs
 *   signatureFeeLamports / prioritizationFeeLamports / rentFeeLamports
 *                                              execution cost, used to size the
 *                                              minimum economical harvest
 */

const PRO_BASE = 'https://api.jup.ag/swap/v2';
const LITE_BASE = 'https://lite-api.jup.ag/swap/v1';

/*
 * Client-side rate limiting.
 *
 * Jupiter's free tier allows 1 request/second, enforced per ORGANISATION over a
 * 60-second sliding window -- extra API keys do not raise it. Loading the rules
 * page fires several route probes at once, which blows that budget instantly and
 * surfaces as a 429 that previously looked like "this asset has no route".
 *
 * So outbound requests are serialised through a minimum-interval queue rather
 * than fired in parallel. Combined with the probe cache, a warm page makes
 * almost no Jupiter calls at all.
 *
 * /swap/v2/execute has its OWN bucket in Jupiter's limiter, so it gets its own
 * queue here: signing must never wait behind background quote traffic.
 */
function makeLimiter(requestsPerSecond) {
  const minIntervalMs = 1000 / Math.max(0.1, requestsPerSecond);
  let chain = Promise.resolve();
  let lastStartedAt = 0;

  return function schedule(task) {
    const runner = chain.then(async () => {
      const wait = lastStartedAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStartedAt = Date.now();
      return task();
    });
    // Keep the queue alive regardless of individual failures.
    chain = runner.then(() => undefined, () => undefined);
    return runner;
  };
}

/*
 * Observed: the keyless endpoint is stricter than the documented free-tier
 * 1 req/s, which is the budget you get WITH a key. So the default adapts --
 * a keyed client uses the documented rate, a keyless one backs off further.
 */
const DEFAULT_RPS = process.env.JUPITER_API_KEY ? 1 : 0.6;
const mainLimit = makeLimiter(Number(process.env.JUPITER_RPS || DEFAULT_RPS));
const executeLimit = makeLimiter(Number(process.env.JUPITER_EXECUTE_RPS || 5));

export function limiterConfig() {
  return {
    mainRps: Number(process.env.JUPITER_RPS || DEFAULT_RPS),
    executeRps: Number(process.env.JUPITER_EXECUTE_RPS || 5),
    keyed: Boolean(process.env.JUPITER_API_KEY),
  };
}

function config() {
  const apiKey = process.env.JUPITER_API_KEY || '';
  return {
    base: process.env.JUPITER_API_BASE || PRO_BASE,
    apiKey,
    headers: apiKey ? { 'x-api-key': apiKey } : {},
  };
}

export class JupiterError extends Error {
  constructor(message, { status, code, transient = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    // A transient error says nothing about whether a route exists. Conflating
    // "could not ask" with "the answer is no" is how a tradable asset ends up
    // marked untradable.
    this.transient = transient;
  }
}

/** Rate limits, upstream faults and network failures are retryable non-answers. */
function isTransientStatus(status) {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/**
 * Jupiter returns HTTP 400 for two very different things:
 *
 *   TOKEN_NOT_TRADABLE                  - permanent: the token has no market
 *   "Quote not available from market
 *    maker" / COULD_NOT_FIND_ANY_ROUTE  - momentary: nobody quoted THIS request
 *
 * The second is load- and timing-dependent -- assets that return it under
 * pressure quote normally seconds later -- so it is a non-answer, not a verdict.
 * Only the first may mark an asset untradable.
 */
const DEFINITIVE_CODES = new Set(['TOKEN_NOT_TRADABLE']);

function isDefinitiveRejection({ status, code, message }) {
  if (status !== 400) return false;
  if (code && DEFINITIVE_CODES.has(code)) return true;
  if (code) return false;
  return /not tradable/i.test(String(message || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build an order. Omit `taker` for a quote-only read (transaction comes back null);
 * pass the user's wallet to get a signable transaction.
 */
export async function getOrder({ inputMint, outputMint, amountRawAtomic, taker, slippageBps = 50, retries = 2 }) {
  const { base, headers } = config();
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRawAtomic),
    slippageBps: String(slippageBps),
  });
  if (taker) qs.set('taker', taker);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await mainLimit(() => fetch(`${base}/order?${qs}`, { headers }));
    } catch (err) {
      lastError = new JupiterError(`Jupiter unreachable: ${err.message}`, { transient: true });
      if (attempt < retries) { await sleep(400 * 2 ** attempt); continue; }
      throw lastError;
    }

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }

    if (res.ok) return normalizeOrder(body);

    const message = body.error || `Jupiter order failed (${res.status})`;
    const definitive = isDefinitiveRejection({ status: res.status, code: body.errorCode, message });
    const transient = isTransientStatus(res.status) || (res.status === 400 && !definitive);
    lastError = new JupiterError(message, { status: res.status, code: body.errorCode, transient });
    // Retry only rate limits and upstream faults. A momentary 400 is reported as
    // unknown rather than retried, which would just burn the request budget.
    if (isTransientStatus(res.status) && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
    throw lastError;
  }
  throw lastError;
}

function normalizeOrder(body) {
  return {
    inputMint: body.inputMint,
    outputMint: body.outputMint,
    inAmount: String(body.inAmount),
    outAmount: String(body.outAmount),
    otherAmountThreshold: String(body.otherAmountThreshold ?? body.outAmount),
    priceImpactPct: String(body.priceImpactPct ?? '0'),
    slippageBps: Number(body.slippageBps ?? 0),
    requestId: body.requestId ?? null,
    transaction: body.transaction ?? null,
    inUsdValue: body.inUsdValue ?? null,
    outUsdValue: body.outUsdValue ?? null,
    router: body.router ?? null,
    swapMode: body.swapMode ?? null,
    gasless: Boolean(body.gasless),
    routePlan: (body.routePlan || []).map((p) => ({
      label: p.swapInfo?.label ?? p.label ?? 'unknown',
      percent: p.percent,
    })),
    costs: {
      signatureFeeLamports: Number(body.signatureFeeLamports ?? 0),
      prioritizationFeeLamports: Number(body.prioritizationFeeLamports ?? 0),
      rentFeeLamports: Number(body.rentFeeLamports ?? 0),
    },
    raw: body,
  };
}

/**
 * Submit a transaction the user has signed. Jupiter broadcasts and confirms.
 * A non-"Success" status is a failure and must never produce an executed receipt.
 */
export async function executeOrder({ signedTransactionBase64, requestId }) {
  const { base, headers } = config();
  const res = await executeLimit(() => fetch(`${base}/execute`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ signedTransaction: signedTransactionBase64, requestId }),
  }));
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }

  if (!res.ok) {
    throw new JupiterError(body.error || `Jupiter execute failed (${res.status})`, {
      status: res.status,
      code: body.errorCode,
    });
  }
  const ok = String(body.status ?? '').toLowerCase() === 'success';
  return {
    ok,
    status: body.status ?? 'Unknown',
    signature: body.signature ?? null,
    slot: body.slot ?? null,
    code: body.code ?? null,
    error: body.error ?? null,
    inputAmountResult: body.inputAmountResult ?? null,
    outputAmountResult: body.outputAmountResult ?? null,
    raw: body,
  };
}

/**
 * Is this mint routable?
 *
 * Returns THREE outcomes, not two. `unknown` means the question could not be
 * asked -- a rate limit or an upstream fault -- and must never be presented to a
 * user as "no route exists". Results are cached so a form that re-checks on every
 * keystroke does not hammer the API into rate-limiting itself.
 */
const tradableCache = new Map();
const TRADABLE_TTL_MS = Number(process.env.JUPITER_PROBE_TTL_MS || 10 * 60 * 1000);

export async function isTradable({
  mint,
  referenceMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  probeAmount = '10000000',
  useCache = true,
}) {
  const key = `${referenceMint}->${mint}:${probeAmount}`;
  if (useCache) {
    const hit = tradableCache.get(key);
    if (hit && Date.now() - hit.at < TRADABLE_TTL_MS) return { ...hit.value, cached: true };
  }

  let value;
  try {
    // retries: 0 -- a probe is a UI hint, and the route is re-quoted for real
    // before anything is signed. Spending retries here starves that.
    const order = await getOrder({ inputMint: referenceMint, outputMint: mint, amountRawAtomic: probeAmount, retries: 0 });
    value = { tradable: true, unknown: false, priceImpactPct: order.priceImpactPct, route: order.routePlan };
  } catch (err) {
    if (err.transient) {
      // Do NOT cache a non-answer, and do not claim the asset is untradable.
      return {
        tradable: false,
        unknown: true,
        reason: err.status === 429 ? 'RATE_LIMITED'
          : err.status === 400 ? 'NO_QUOTE_RIGHT_NOW'
          : 'JUPITER_UNAVAILABLE',
        detail: err.message,
      };
    }
    value = { tradable: false, unknown: false, reason: err.code || err.message };
  }
  tradableCache.set(key, { at: Date.now(), value });
  return value;
}

/** Keyless lite endpoint, used only for cheap tradability probes when no key is configured. */
export async function liteQuote({ inputMint, outputMint, amountRawAtomic, slippageBps = 50 }) {
  const qs = new URLSearchParams({ inputMint, outputMint, amount: String(amountRawAtomic), slippageBps: String(slippageBps) });
  const res = await mainLimit(() => fetch(`${LITE_BASE}/quote?${qs}`));
  if (!res.ok) throw new JupiterError(`lite quote ${res.status}`, { status: res.status });
  return res.json();
}
