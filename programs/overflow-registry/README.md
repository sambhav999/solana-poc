# Overflow Receipt Registry

On-chain rule + receipt PDAs. The program never holds tokens and never
signs Jupiter or Kamino moves. The user's wallet is always the fee payer.

Program id (this keypair): `nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp`

## Instructions

- `create_rule(rule_id: [u8;16], source_kind: u8, destination_mint, source_mint)`
  - PDA `["rule", owner, rule_id]`
- `post_receipt(execution_key: [u8;32], source_spent, destination_received, preserved, swap_signature)`
  - PDA `["receipt", owner, execution_key]`
  - Fails if the same execution key is posted twice

## Test (no Solana CLI required)

```bash
cargo test --manifest-path programs/overflow-registry/Cargo.toml
cd backend && npm test
```

## Deploy to devnet (later)

Install Solana CLI, then:

```bash
solana config set --url https://api.devnet.solana.com
solana airdrop 2
cargo build-sbf --manifest-path programs/overflow-registry/Cargo.toml
solana program deploy \
  --program-id programs/overflow-registry/keys/overflow_registry-keypair.json \
  programs/overflow-registry/target/deploy/overflow_registry.so \
  --url devnet
```

Then set on the backend:

```
OVERFLOW_REGISTRY_PROGRAM_ID=nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp
NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
```

And on the frontend:

```
VITE_SOLANA_CLUSTER=devnet
VITE_EXPLORER_BASE=https://solscan.io/tx
```

Until `OVERFLOW_REGISTRY_PROGRAM_ID` is set, the API still creates SQLite
rules and receipts and skips the on-chain transactions.
