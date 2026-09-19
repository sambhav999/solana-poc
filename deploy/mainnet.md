# Mainnet env checklist

Program id (same as devnet if you deploy with the same program keypair):

`nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp`

That string goes on the **backend only** as `OVERFLOW_REGISTRY_PROGRAM_ID`. The frontend does not need it. Set `VITE_SOLANA_CLUSTER=mainnet` so Phantom uses `solana:mainnet`.

Vite inlines `VITE_*` at build time. After editing `frontend/.env`, restart `npm run dev` or rebuild the Workers site.

Use this file after the program is on mainnet. Do not switch these values until `solana program show nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp --url mainnet-beta` succeeds.

Mainnet deploy uses real SOL on the CLI wallet. No airdrop.

## Commands to run (in order)

Finish **devnet first**. Use the same Solana CLI install and the same `~/.config/solana/id.json` from `deploy/devnet.md`. Do not create a new program keypair.

Run these in Terminal from `/Users/rishabhjaiswal/Desktop/solana-poc`.

```bash
# 1. Confirm CLI is installed
solana --version
solana address

# 2. Point CLI at mainnet. No airdrop.
solana config set --url https://api.mainnet-beta.solana.com
solana balance

# 3. Fund the CLI wallet with real SOL if balance is too low
#    (deploy typically needs a few SOL for program rent + fees)

# 4. Build the program (skip if you already built for devnet and have not changed it)
cargo build-sbf --manifest-path programs/overflow-registry/Cargo.toml

# 5. Deploy to mainnet (same program id as devnet)
solana program deploy \
  --program-id programs/overflow-registry/keys/overflow_registry-keypair.json \
  programs/overflow-registry/target/deploy/overflow_registry.so \
  --url mainnet-beta

# 6. Confirm it is live on mainnet before changing any env
solana program show nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp --url mainnet-beta

# 7. After deploy: paste the backend/frontend values below, then
openssl rand -hex 32
```

After step 6 succeeds, add the env values below to `backend/.env` and Render, then to `frontend/.env`, and rebuild the frontend.

## Where each file lives

| Place | File or dashboard |
|---|---|
| Local backend | `backend/.env` |
| Render backend | Render → Environment |
| Local frontend | `frontend/.env` then restart Vite |
| Live frontend | `frontend/.env` then rebuild / redeploy Workers |
| Solana CLI deployer | `~/.config/solana/id.json` (not an env var, not Phantom) |

## Must add — backend (`backend/.env` and Render)

```
OVERFLOW_REGISTRY_PROGRAM_ID=nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp
NETWORK=mainnet-beta
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
CORS_ORIGIN=http://localhost:5173,https://noisy-sky-fa9c.rj838486.workers.dev
SESSION_SECRET=
```

Prefer a paid RPC URL in `SOLANA_RPC_URL` for a live demo (Helius, Triton, QuickNode). Public mainnet RPC rate-limits quickly.

Generate `SESSION_SECRET` with `openssl rand -hex 32`. Required on Render when `NODE_ENV=production`.

## Must add — frontend (`frontend/.env`)

```
VITE_API_BASE=https://solana-poc.onrender.com/api
VITE_SOLANA_CLUSTER=mainnet
VITE_EXPLORER_BASE=https://solscan.io/tx
```

For a local API instead, set `VITE_API_BASE=http://localhost:8787/api`.

## Keep on the backend (already part of the app)

```
PORT=8787
KAMINO_USDC_VAULT=HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E
KAMINO_SHARE_DECIMALS=6
DATABASE_PATH=./data/overflow.db
```

## Optional backend (leave empty unless you have them)

```
JUPITER_API_KEY
PYTH_PRICE_API_URL
PYTH_API_KEY
POLL_INTERVAL_MS
CRON_SECRET
```

## Do not put in env files

- Program keypair file in `programs/overflow-registry/keys/` — used only for `solana program deploy`
- CLI wallet at `~/.config/solana/id.json` — pays deploy fees, becomes upgrade authority
- Phantom export — users sign in the browser; Overflow never holds it
