import { NextResponse } from 'next/server';

/**
 * Direct Jupiter quoting is deliberately disabled in the deployed app.
 *
 * All swaps must be created through /api/execution/prepare, which derives the
 * input mint, amount, destination, slippage limit and taker from a server-side
 * execution intent. Exposing a generic proxy here would let arbitrary callers
 * consume the deployment's Jupiter API key and bypass Overflow's rule guards.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: 'Direct Jupiter order proxy disabled. Use /api/execution/prepare with a server-created intent.',
      status: 'BLOCKED',
    },
    { status: 410 }
  );
}
