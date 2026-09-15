# Overflow — final deployment integrity pass

This pass contains correctness and deployment-hardening changes only. The frozen product scope is unchanged.

> **Verification status:** the source was statically reconciled in this environment, but a fresh dependency install / TypeScript build and funded mainnet execution could not be completed here because external npm registry access timed out and no production wallet/API credentials were available. Before submission, run the commands in `FINAL_DEPLOY_CHECKLIST.md`.

## Blockers fixed

### 1. Kamino interest is now a true two-step earnings flow

For `KAMINO_INTEREST`, Overflow no longer goes directly to Jupiter. It now:

1. prepares a Kamino withdrawal for the isolated harvestable earnings;
2. asks the user to sign it;
3. confirms that transaction server-side;
4. measures the **actual USDC delta from the confirmed transaction metadata**;
5. updates the Kamino share baseline;
6. prepares a Jupiter swap for no more than the actual received USDC;
7. asks the user to sign the swap;
8. verifies the resulting source position and destination-token delta onchain.

If the withdrawal lands but the swap does not complete, the same execution intent remains resumable and a second withdrawal is not prepared.

### 2. Kamino accounting follows current SDK units

The adapter now uses the current `KaminoVault` API and keeps monetary calculations in `Decimal`:

- `getUserShares(user).totalShares` — human Kamino share units;
- `getExchangeRate(slot)` — underlying tokens per share;
- `redeemable = totalShares × exchangeRate`;
- `withdrawIxs(..., new Decimal(sharesAmount))` — withdrawal expressed in Kamino share units.

There is no JavaScript `Number()` conversion of a u64 share balance in the money-moving path. `npm run verify:kamino -- <wallet>` is provided to compare Overflow's `redeemableUsd` against the Kamino UI before any funded execution.

### 3. Dividend events are idempotent

`processed_events` is keyed by `(rule_id, event_id)`. A processed event is blocked before evaluation, and the source raw xStock balance is re-read immediately before swap preparation. If it differs from the balance used for the dividend snapshot, execution moves to review rather than recalculating against a changed source.

### 4. Receipts verify instead of assert

The old unconditional `preserved: true` behavior is gone. After settlement, Overflow re-reads protocol/onchain state and stores:

- real source before/after;
- routed earnings;
- destination token delta from the specific transaction;
- real exposure/principal before/after;
- `VERIFIED_ON_CHAIN`, `UNVERIFIED`, or `FAILED`.

A receipt is allowed to fail verification. That is intentional.

## Additional integrity fixes

- Exact corporate-action/multiplier linkage only; no "nearest timestamp" or "latest two multiplier" fallback.
- Rule waits until the post-event multiplier is actually live and the configured safety window has elapsed.
- RPC errors throw instead of silently becoming zero balances.
- Preservation inequality is strict; no artificial tolerance.
- Safety guards return `WAITING`, `BLOCKED`, or `NEEDS_REVIEW` instead of generic server errors.
- `maxSlippageBps` is persisted per rule and checked before signing.
- Destination xStock mints are resolved server-side from xStocks rather than trusted from the browser.
- xStocks base URL is consistently `https://api.xstocks.fi/api/v2` unless explicitly overridden.
- Production refuses the in-memory repository; Supabase is mandatory.
- Retry-safe receipts are unique per execution intent.
- Kamino external share changes pause the rule until the principal baseline is reconfirmed.
- Replay Mode stays explicitly historical and never represents a fixture as a live corporate action.

## Database migrations

Apply in order:

```text
db/migrations/001_init.sql
db/migrations/002_integrity.sql
db/migrations/003_final_verification.sql
db/migrations/004_dividend_attribution_and_order_binding.sql
```

## Mandatory checks before submission

1. `npm ci`
2. `npm run check`
3. Run all four migrations, then `npm run verify:db`
4. `npm run verify:xstocks`
5. `npm run preflight:prod`
6. `npm run verify:kamino -- <wallet-with-real-USDC-vault-position>` and compare `redeemableUsd` to the Kamino UI
7. Produce at least one funded execution and a `VERIFIED_ON_CHAIN` receipt
8. Put the successful Solana signature and deployed URL in the README/submission

Until steps 6–8 are complete, the repository is **deploy-ready for live verification**, not yet evidence of a successfully mainnet-verified submission.

## Final attribution / order-binding hardening

- Dividend rules now persist the raw Token-2022 source balance at activation and refuse attribution if it drifts outside Overflow.
- A verified dividend execution refreshes the raw baseline to the observed post-swap source balance.
- Jupiter `requestId` is server-bound to the execution intent.
- The prepared unsigned transaction message is SHA-256 hashed; a wallet-signed transaction with different message bytes is rejected before `/execute`.
- xStocks v2 parsing accepts both `items` and paginated `nodes` envelopes and `tokenDeployments` asset metadata.
- Kamino vault construction follows the current two-argument `KaminoVault(rpc, address)` documentation and uses the public RPC object for the current slot.


## Final signature / receipt hardening

- Kamino withdrawal preparation now stores the unsigned transaction-message hash; confirmation rejects any signed transaction with different message bytes.
- The generic `/api/jupiter/order` proxy is disabled so a deployment API key cannot be used to create arbitrary swaps outside the rule engine.
- A `VERIFIED_ON_CHAIN` receipt now requires three independent facts: the source position invariant holds, the exact source-token delta equals the server-authorized routed amount, and the destination token increased in that same transaction.
- Missing transaction metadata degrades a receipt to `UNVERIFIED`; an observed source-spend mismatch is `FAILED`.
