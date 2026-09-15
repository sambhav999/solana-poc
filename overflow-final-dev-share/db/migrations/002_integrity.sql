-- Integrity additions: server-side intents, idempotency, verified receipts.

alter table rules add column if not exists max_slippage_bps integer not null default 50;
alter table rules add column if not exists principal_floor_source text;

create table if not exists intents (
  id uuid primary key,
  rule_id uuid references rules(id) on delete cascade,
  wallet text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists intents_rule_idx on intents(rule_id);

-- One execution per (rule, corporate action). This is what stops a second pass
-- extracting from the preserved source after a successful dividend route.
create table if not exists processed_events (
  rule_id uuid not null references rules(id) on delete cascade,
  event_id text not null,
  signature text not null,
  created_at timestamptz not null default now(),
  primary key (rule_id, event_id)
);

alter table receipts add column if not exists intent_id uuid;
alter table receipts add column if not exists kind text;
alter table receipts add column if not exists exposure_before text;
alter table receipts add column if not exists exposure_after text;
alter table receipts add column if not exists verification text not null default 'UNVERIFIED';
alter table receipts add column if not exists verification_note text;


-- Detect external Kamino principal mutations by tracking whole vault shares.
alter table rules add column if not exists vault_shares_baseline text;
