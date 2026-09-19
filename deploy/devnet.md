# Devnet env checklist

Program id (constant across clusters when you deploy with the repo program keypair):

`nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp`

That string goes on the **backend only**. The frontend does not need it. Phantom signs the unsigned transaction the API already built. The frontend only needs `VITE_SOLANA_CLUSTER=devnet` so the wallet uses `solana:devnet`.

Vite inlines `VITE_*` at `npm run dev` / `npm run build`. Changing Render does not update the live UI. Rebuild the frontend after editing `frontend/.env`.

Jupiter, Kamino, and xStocks are mainnet products. A full-devnet backend is for proving `create_rule` / `post_receipt`. Harvests may fail until you use `deploy/mainnet.md`.

## Commands to run (in order)

Run these in Terminal from `/Users/rishabhjaiswal/Desktop/solana-poc`. Skip step 1 if `solana --version` already works. Skip step 2 if `~/.config/solana/id.json` already exists.

```bash
# 1. Install Solana CLI (once)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
solana --version

# 2. Create the deployer wallet (once). This is NOT Phantom.
solana-keygen new --outfile ~/.config/solana/id.json
solana address

# 3. Point CLI at devnet and fund it (test SOL)
solana config set --url https://api.devnet.solana.com
solana airdrop 2
solana balance

# 4. Build the program
cargo build-sbf --manifest-path programs/overflow-registry/Cargo.toml

# 5. Deploy to devnet (same program id)
solana program deploy \
  --program-id programs/overflow-registry/keys/overflow_registry-keypair.json \
  programs/overflow-registry/target/deploy/overflow_registry.so \
  --url devnet

# 6. Confirm it is live
solana program show nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp --url devnet

# 7. After deploy: paste the backend/frontend values below, then
openssl rand -hex 32
```

If `solana airdrop` fails, request 2 SOL at https://faucet.solana.com using the address from `solana address`.

After step 6 succeeds, add the env values below to `backend/.env` and `frontend/.env`, restart the API, then restart or rebuild the frontend.

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
NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
CORS_ORIGIN=http://localhost:5173,https://noisy-sky-fa9c.rj838486.workers.dev
SESSION_SECRET=
```

Generate `SESSION_SECRET` with `openssl rand -hex 32`. Required on Render when `NODE_ENV=production`.

## Must add — frontend (`frontend/.env`)

```
VITE_API_BASE=https://solana-poc.onrender.com/api
VITE_SOLANA_CLUSTER=devnet
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
