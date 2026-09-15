-- Final deployment integrity fields.
-- Kamino totalShares baseline is stored in human share units as text/numeric-safe text,
-- never JavaScript float, and refreshed only after a verified successful harvest.
alter table rules add column if not exists vault_shares_baseline text;

-- Helpful uniqueness for a single receipt per intent in retry/reload scenarios.
create unique index if not exists receipts_intent_unique_idx on receipts(intent_id)
where intent_id is not null;
