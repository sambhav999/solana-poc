# Stocklana Submission — Overflow

## Name
Overflow

## Tagline
**Keep the source. Program the earnings.**

## Short description
Overflow is the programmable earnings layer for onchain assets. Users preserve the asset they want to keep while routing only newly generated economic value—such as Kamino USDC interest or xStocks cash-dividend exposure—into another asset through Jupiter.

## What we built

- Solana-first earnings rule engine
- xStocks v2 corporate-action + multiplier integration
- dividend-only isolation using Token-2022 raw balance accounting
- Kamino USDC Earn integration with explicit principal-floor protection
- Jupiter Swap API V2 order/sign/execute flow
- wallet authentication and user-signed non-custodial execution
- receipts that verify source preservation
- historical xStocks Replay Mode when no live dividend is available

## Core dividend equation

For raw xStock balance `R`, pre-dividend multiplier `m0`, and post-dividend multiplier `m1`:

```text
dividendRaw = floor(R × (m1 − m0) / m1)
```

After routing `dividendRaw`, the remaining raw quantity multiplied by `m1` must remain greater than or equal to the pre-dividend equity exposure. The removable amount is rounded down, so the preservation check uses a strict inequality with no artificial tolerance.

## Why it is different

Overflow is not “USDC yield buys stocks.” That behavior exists elsewhere.

The reusable product is the **Earnings Rule Engine**:

```text
Keep this asset.
Whenever it generates new economic value,
route only that value here.
```

## Submission scope

Only:

- Solana
- xStocks cash dividends
- one Kamino USDC Earn vault
- Jupiter Swap V2
- USDC/SPYx/QQQx/NVDAx destinations where routable
- rules, execution review, receipts, Replay Mode

No AI, token, cross-chain, custom stock issuer, social system, or custom Solana program.

## Post-hackathon

The same engine can normalize:

- stablecoin yield
- stock dividends
- bond coupons
- staking rewards
- LP fees
- treasury/RWA cash flows

Consumer product: **Overflow**

Infrastructure product: **Overflow SDK** for wallets, exchanges, issuers and fintech apps.


## Final verification before submission

Do not represent the project as mainnet-verified until all production checks have passed. Before publishing the final Stocklana entry, replace the placeholders below with the deployed app and a real successful execution that generated a `VERIFIED_ON_CHAIN` receipt.

```text
Production URL: PENDING
Verified Solana transaction: PENDING
```

If no live xStocks cash-dividend event occurs during the judging window, demonstrate the corporate-action logic in the clearly labelled historical **Replay Mode** and use a real Kamino/Jupiter execution for the live settlement proof.
