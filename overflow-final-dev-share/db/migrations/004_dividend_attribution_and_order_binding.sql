-- Dividend attribution integrity.
-- Corporate actions change xStocks' multiplier but not the Solana raw Token-2022
-- balance. Store a trusted raw balance baseline so external buys/sells/transfers
-- cannot be mistaken for dividend-created exposure.
alter table rules add column if not exists dividend_raw_baseline text;
alter table rules add column if not exists dividend_source_decimals integer;

comment on column rules.dividend_raw_baseline is
  'Raw source Token-2022 balance trusted for dividend attribution; refreshed only after VERIFIED_ON_CHAIN Overflow execution.';
comment on column rules.dividend_source_decimals is
  'Token decimals observed with dividend_raw_baseline.';
