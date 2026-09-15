const BASE = (process.env.JUPITER_BASE_URL || 'https://api.jup.ag').replace(/\/+$/, '');

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (process.env.JUPITER_API_KEY) h['x-api-key'] = process.env.JUPITER_API_KEY;
  return h;
}

export async function jupiterOrder(args: {
  inputMint: string; outputMint: string; amount: string; taker: string; slippageBps?: number;
}) {
  const q = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount,
    taker: args.taker,
    slippageBps: String(args.slippageBps ?? Number(process.env.DEFAULT_MAX_SLIPPAGE_BPS || 50))
  });
  const r = await fetch(`${BASE}/swap/v2/order?${q}`, { headers: headers(), cache: 'no-store' });
  if (!r.ok) throw new Error(`Jupiter order failed ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function jupiterExecute(signedTransaction: string, requestId?: string) {
  const r = await fetch(`${BASE}/swap/v2/execute`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ signedTransaction, requestId })
  });
  if (!r.ok) throw new Error(`Jupiter execute failed ${r.status}: ${await r.text()}`);
  return r.json();
}
