# Overflow — final deploy / submission gate

The code is frozen. Deployment is the start of live-service verification, not proof that the integration works.

## 0. Install + static checks

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Do not continue if any command fails.

## 1. Apply all database migrations

Run in order:

```text
db/migrations/001_init.sql
db/migrations/002_integrity.sql
db/migrations/003_final_verification.sql
db/migrations/004_dividend_attribution_and_order_binding.sql
```

Then:

```bash
npm run verify:db
```

A production deploy without Supabase is intentionally rejected.

## 2. Verify xStocks API + DVCA availability

```bash
npm run verify:xstocks -- MRKx
npm run preflight:prod
```

The xStocks host is set to the current documented public v2 base:
`https://api.xstocks.fi/api/v2`.

`verify:xstocks` checks:
- asset / Solana mint discovery
- price-data
- current multiplier
- multiplier history
- corporate actions
- an exact event→multiplier match for the latest cash dividend

If no suitable dividend exists in the judging window, use Replay Mode and label it historical.

## 3. Verify Kamino units against a funded position

Use a wallet that really holds the configured Kamino USDC Earn position:

```bash
npm run verify:kamino -- <wallet>
```

Compare `redeemableUsd` to the Kamino UI for the same wallet/vault. They must agree to ordinary display rounding.

Current adapter convention:
- `totalShares` = human share units
- `exchangeRate` = USDC per share
- `redeemableUsd = totalShares * exchangeRate`
- `withdrawIxs` receives share units, not atomic units

If this manual comparison fails, STOP. Do not sign a mainnet withdrawal.

## 4. One funded end-to-end execution

### Interest path

1. Create a Kamino interest rule with an explicit principal floor.
2. Check earnings.
3. Sign Kamino withdrawal.
4. Backend verifies the exact USDC delta from that transaction.
5. Backend prepares Jupiter only for `min(exact withdrawal delta, isolated earnings)`.
6. Sign Jupiter swap.
7. Receipt must show `VERIFIED_ON_CHAIN` and the Kamino position must remain >= principal floor.

### Dividend path

If a live eligible DVCA exists:
1. Exact corporate action resolves to exact multiplier history entry.
2. Safety window has passed and m1 is live.
3. Raw xStock balance must still match the persistent rule baseline captured at activation; any external drift returns `NEEDS_REVIEW`.
4. The same raw balance is snapshotted again immediately before quote.
5. Route only `floor(R * (m1-m0)/m1)`.
6. Receipt re-reads source, verifies pre-event exposure remains covered, verifies the exact source-token spend, and proves a positive destination-token delta from the same transaction.
7. Re-evaluating the same event must say already processed.

If no live DVCA exists, use the explicit historical Replay Mode and execute the interest path live.

## 5. Submission proof

Before submission, put at least one real verified transaction signature into README under `Verified demo transaction`.

The submission is not complete until one receipt says:

```text
VERIFIED_ON_CHAIN
```

and the linked Solana transaction is publicly viewable.
