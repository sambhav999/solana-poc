# Dev notes — read before deployment

## 1. Run the migration first

The app intentionally fails if Supabase is not configured. Run `db/migrations/001_init.sql`, `002_integrity.sql`, `003_final_verification.sql`, and `004_dividend_attribution_and_order_binding.sql` in order, then set the service-role environment variables.

## 2. Verify the Kamino vault address

`.env.example` intentionally leaves `KAMINO_USDC_VAULT` blank. Set it explicitly to the USDC Earn vault you intend to demo, set the matching `NEXT_PUBLIC_KAMINO_USDC_VAULT` only if the frontend needs to display it, and run `npm run preflight:prod` immediately before deployment. Do not rely on a documentation-example vault address without verifying it on Kamino.

## 3. Funded mainnet wallet is required for the true E2E path

The code is wired to real mainnet protocols. A developer still needs a wallet that actually holds:

- source xStock for a dividend execution, and/or
- Kamino USDC vault shares plus enough earned interest
- small SOL balance if the swap is not gasless

No codebase can manufacture those live positions.

## 4. Dividend rule baseline

When a dividend rule is created, Overflow stores both the current latest cash-dividend `eventId` and the wallet's raw Token-2022 xStock balance. The event baseline prevents a new rule from claiming an old dividend; the raw-balance baseline prevents post-event buys/sells/transfers from being misclassified as dividend-created exposure. Any raw drift returns `NEEDS_REVIEW`. The raw baseline is refreshed only after a `VERIFIED_ON_CHAIN` Overflow dividend execution.

Only a later event can create a live execution intent.

Use Replay Mode for old events.


## 5. Jupiter order binding

`/api/execution/prepare` stores the Jupiter `requestId` plus a SHA-256 hash of the unsigned versioned transaction message. `/api/jupiter/execute` rejects a different requestId or a signed transaction whose message bytes do not match the prepared order. It then calls Jupiter with the server-stored requestId.

## 6. Kamino withdrawal binding

`/api/kamino/prepare-withdraw` stores a SHA-256 hash of the unsigned withdrawal transaction message. `/api/execution/confirm` rejects a wallet-signed transaction whose message bytes do not match that exact prepared withdrawal. This prevents a different signed transaction from being credited as the Kamino earnings withdrawal.

## 7. User rejection does not poison an intent

Creating a Jupiter order does not move the intent to EXECUTING. The status changes only when the signed transaction is posted to `/execute`. This lets the user reject/re-open wallet signing safely.

## 8. Kamino is a two-transaction V1 flow

For interest rules:

1. user signs Kamino withdrawal
2. backend confirms and measures received USDC delta
3. user signs Jupiter swap
4. receipt verifies principal floor

Do not claim atomicity across Kamino withdrawal + Jupiter swap in the submission.

The generic `/api/jupiter/order` proxy is intentionally disabled; all Jupiter orders must originate from `/api/execution/prepare` and a server-created intent.

## 9. xStocks terminology

Overflow accepts only cash-dividend corporate actions (`CashDividend` and the ISO-style `DVCA` code) as earnings. Split/reverse-split event types such as `SPLF`/`SPLR`, `ForwardSplit`, `ReverseSplit`, `UnitSplit`, and all other corporate actions are ignored.

## 10. Mainnet safety

Keep `DEFAULT_MAX_SLIPPAGE_BPS` conservative. Do not increase it just to force a demo route. If Jupiter returns no route, show that honestly and choose a more liquid destination.

## 11. Before filming the demo

Run:

```bash
npm run preflight
npm run typecheck
npm test
npm run build
```

Then manually test:

- wallet sign-in
- create/pause/resume rule
- manual evaluate endpoint
- Replay Mode
- real Jupiter order signing with a tiny funded amount
- Solscan receipt link

## 12. What is not included

No custody, no delegated spending, no custom Solana program, no automated unattended execution, no cross-chain layer, no AI.
