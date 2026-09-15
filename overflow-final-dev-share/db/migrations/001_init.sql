create table if not exists rules (
 id uuid primary key, wallet text not null, kind text not null,
 source_symbol text not null, destination_symbol text not null, destination_mint text not null,
 min_execution_usd numeric not null default 5, status text not null default 'ACTIVE',
 principal_floor_usd numeric, safety_buffer_usd numeric, vault_address text,
 baseline_event_id text, created_at timestamptz not null default now()
);
create index if not exists rules_wallet_idx on rules(wallet);

create table if not exists receipts (
 id uuid primary key, wallet text not null, rule_id uuid references rules(id) on delete set null,
 signature text not null, title text not null, source_before text not null,
 earnings_routed text not null, destination_received text not null,
 source_after text not null, preserved boolean not null default false,
 created_at timestamptz not null default now()
);
create index if not exists receipts_wallet_idx on receipts(wallet);
