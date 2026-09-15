import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db = createClient(url, key, { auth: { persistSession: false } });
  for (const table of ['rules', 'intents', 'processed_events', 'receipts']) {
    const { error } = await db.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    if (error) throw new Error(`${table}: ${error.message}`);
    console.log('✓', table);
  }

  // Column-level smoke check for migrations 002-004.
  const { error: ruleColumns } = await db.from('rules')
    .select('vault_shares_baseline,dividend_raw_baseline,dividend_source_decimals,max_slippage_bps')
    .limit(1);
  if (ruleColumns) throw new Error(`rules integrity columns: ${ruleColumns.message}`);
  console.log('✓ rules integrity columns');

  const { error: receiptColumns } = await db.from('receipts')
    .select('intent_id,verification,verification_note,exposure_before,exposure_after')
    .limit(1);
  if (receiptColumns) throw new Error(`receipts verification columns: ${receiptColumns.message}`);
  console.log('✓ receipt verification columns');

  console.log('Database verification passed.');
}

main().catch(e => { console.error('verify:db failed:', e.message); process.exit(1); });
