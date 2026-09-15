# Overflow — final build status

## Frozen product scope

- Solana
- xStocks cash-dividend earnings rule
- Kamino USDC Earn interest rule
- Jupiter Swap V2
- SPYx / QQQx / NVDAx destinations resolved from xStocks
- user-signed non-custodial transactions
- verified receipts
- explicitly historical Replay Mode

No AI, token, cross-chain layer, custom Solana program, custody, or unattended signing.

## Integrity corrections included

- Kamino interest execution is withdrawal-first, then Jupiter.
- Exact transaction USDC delta is the routing authority after Kamino withdrawal.
- Kamino monetary math uses `Decimal`; share units follow the current `KaminoVault` convention.
- Dividend events are idempotent per `(ruleId,eventId)`.
- Dividend rules persist a trusted raw Token-2022 balance baseline at activation; external balance drift pauses attribution.
- Source raw balance is rechecked again immediately before dividend execution.
- Corporate action to multiplier matching never guesses a nearby pair.
- xStocks safety window and live multiplier are both required.
- RPC failures are errors, not silent zero balances.
- Receipts are post-transaction verified and may return FAILED/UNVERIFIED.
- `VERIFIED_ON_CHAIN` requires an exact authorized source-token spend plus a positive destination-token delta from the specific Solana transaction.
- Production requires Supabase persistence.
- Per-rule slippage cap is enforced.
- Jupiter execution is bound server-side to the exact prepared `requestId` and transaction message hash.
- Kamino confirmation is bound to the exact server-prepared withdrawal transaction message hash.
- The generic Jupiter order proxy is disabled; only guarded server-side execution intents can prepare swaps.
- Destination mints are resolved server-side from xStocks.
- Rules pause if a Kamino share balance changes outside Overflow.

## Verification performed in this workspace

- source-level consistency pass
- local named-import/export scan
- package.json/package-lock root dependency consistency check
- stale identifier / legacy host / hard-coded destination-mint scan
- current xStocks multiplier/API conventions checked against official documentation
- current Kamino `KaminoVault` two-argument construction and share-based withdrawal flow checked against official docs
- TS/TSX syntax transpile across the final tree

## Verification NOT possible in this workspace

A fresh `npm ci` was attempted but the external registry timed out, so `npm run typecheck`, `npm test`, and `npm run build` could not be truthfully re-run against the final tree here.

No funded wallet, production RPC, Jupiter key, Supabase credentials, or live Kamino position were available, so no mainnet transaction was executed here.

## Required before Stocklana submission

Run `FINAL_DEPLOY_CHECKLIST.md` exactly. The submission gate is one real transaction producing a `VERIFIED_ON_CHAIN` receipt and a public Solana signature.
