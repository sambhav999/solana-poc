import { createClient } from '@supabase/supabase-js';
import type { Rule, Receipt, ExecutionIntent, ProcessedEvent } from './types';

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Supabase is required in production; refusing ephemeral in-memory persistence');
    }
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export function persistenceMode(): 'supabase' | 'memory' {
  return client() ? 'supabase' : 'memory';
}

const memory = globalThis as typeof globalThis & {
  __ovfRules?: Rule[];
  __ovfReceipts?: Receipt[];
  __ovfIntents?: ExecutionIntent[];
  __ovfProcessed?: ProcessedEvent[];
};
memory.__ovfRules ||= [];
memory.__ovfReceipts ||= [];
memory.__ovfIntents ||= [];
memory.__ovfProcessed ||= [];

/* ---------------- rules ---------------- */
export async function listRules(wallet: string): Promise<Rule[]> {
  const db = client();
  if (!db) return memory.__ovfRules!.filter(r => r.wallet === wallet);
  const { data, error } = await db.from('rules').select('*').eq('wallet', wallet).order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(fromDbRule);
}

export async function insertRule(rule: Rule) {
  const db = client();
  if (!db) { memory.__ovfRules!.push(rule); return rule; }
  const { error } = await db.from('rules').insert(toDbRule(rule));
  if (error) throw error;
  return rule;
}

export async function setRuleStatus(id: string, status: Rule['status']) {
  const db = client();
  if (!db) {
    const r = memory.__ovfRules!.find(x => x.id === id);
    if (r) r.status = status;
    return;
  }
  const { error } = await db.from('rules').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function updateRuleVaultSharesBaseline(ruleId: string, sharesAmount: string) {
  const db = client();
  if (!db) {
    const r = memory.__ovfRules!.find(x => x.id === ruleId);
    if (r) r.vaultSharesBaseline = sharesAmount;
    return;
  }
  const { error } = await db.from('rules').update({ vault_shares_baseline: sharesAmount }).eq('id', ruleId);
  if (error) throw error;
}

/** Refresh the dividend source baseline only after a verified Overflow execution. */
export async function updateRuleDividendBaseline(
  ruleId: string,
  rawBalanceAtomic: string,
  sourceDecimals: number,
  baselineEventId?: string
) {
  const db = client();
  if (!db) {
    const r = memory.__ovfRules!.find(x => x.id === ruleId);
    if (r) {
      r.dividendRawBaseline = rawBalanceAtomic;
      r.dividendSourceDecimals = sourceDecimals;
      if (baselineEventId) r.baselineEventId = baselineEventId;
    }
    return;
  }
  const patch: Record<string, unknown> = {
    dividend_raw_baseline: rawBalanceAtomic,
    dividend_source_decimals: sourceDecimals,
  };
  if (baselineEventId) patch.baseline_event_id = baselineEventId;
  const { error } = await db.from('rules').update(patch).eq('id', ruleId);
  if (error) throw error;
}

/* ---------------- intents ---------------- */
export async function saveIntent(intent: ExecutionIntent) {
  const db = client();
  if (!db) {
    memory.__ovfIntents! = memory.__ovfIntents!.filter(i => i.ruleId !== intent.ruleId);
    memory.__ovfIntents!.push(intent);
    return intent;
  }
  const { error } = await db.from('intents').insert({
    id: intent.id, rule_id: intent.ruleId, wallet: intent.wallet,
    payload: intent, created_at: intent.createdAt,
  });
  if (error) throw error;
  return intent;
}

export async function getIntent(id: string): Promise<ExecutionIntent | null> {
  const db = client();
  if (!db) return memory.__ovfIntents!.find(i => i.id === id) || null;
  const { data, error } = await db.from('intents').select('payload').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data?.payload as ExecutionIntent) || null;
}

export async function updateIntent(intent: ExecutionIntent) {
  const db = client();
  if (!db) {
    const idx = memory.__ovfIntents!.findIndex(i => i.id === intent.id);
    if (idx >= 0) memory.__ovfIntents![idx] = intent;
    else memory.__ovfIntents!.push(intent);
    return intent;
  }
  const { error } = await db.from('intents').update({ payload: intent }).eq('id', intent.id);
  if (error) throw error;
  return intent;
}

export async function getLatestIntentForRule(ruleId: string): Promise<ExecutionIntent | null> {
  const db = client();
  if (!db) {
    return memory.__ovfIntents!
      .filter(i => i.ruleId === ruleId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
  }
  const { data, error } = await db.from('intents').select('payload,created_at')
    .eq('rule_id', ruleId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return (data?.payload as ExecutionIntent) || null;
}

/* ---------------- processed dividend events ---------------- */
export async function isEventProcessed(ruleId: string, eventId: string): Promise<boolean> {
  const db = client();
  if (!db) return memory.__ovfProcessed!.some(p => p.ruleId === ruleId && p.eventId === eventId);
  const { data, error } = await db.from('processed_events').select('event_id')
    .eq('rule_id', ruleId).eq('event_id', eventId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function markEventProcessed(p: ProcessedEvent) {
  const db = client();
  if (!db) {
    if (!memory.__ovfProcessed!.some(x => x.ruleId === p.ruleId && x.eventId === p.eventId)) memory.__ovfProcessed!.push(p);
    return;
  }
  const { error } = await db.from('processed_events').upsert({
    rule_id: p.ruleId, event_id: p.eventId, signature: p.signature, created_at: p.createdAt,
  }, { onConflict: 'rule_id,event_id', ignoreDuplicates: true });
  if (error) throw error;
}

/* ---------------- receipts ---------------- */
export async function listReceipts(wallet: string): Promise<Receipt[]> {
  const db = client();
  if (!db) return memory.__ovfReceipts!.filter(r => r.wallet === wallet);
  const { data, error } = await db.from('receipts').select('*').eq('wallet', wallet).order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(fromDbReceipt);
}

export async function getReceiptByIntent(intentId: string): Promise<Receipt | null> {
  const db = client();
  if (!db) return memory.__ovfReceipts!.find(r => r.intentId === intentId) || null;
  const { data, error } = await db.from('receipts').select('*').eq('intent_id', intentId).maybeSingle();
  if (error) throw error;
  return data ? fromDbReceipt(data) : null;
}

export async function insertReceipt(r: Receipt) {
  const db = client();
  if (!db) {
    const existing = memory.__ovfReceipts!.find(x => x.intentId === r.intentId);
    if (existing) return existing;
    memory.__ovfReceipts!.unshift(r);
    return r;
  }
  const { error } = await db.from('receipts').insert({
    id: r.id, wallet: r.wallet, rule_id: r.ruleId, intent_id: r.intentId, signature: r.signature,
    title: r.title, kind: r.kind, source_before: r.sourceBefore, source_after: r.sourceAfter,
    earnings_routed: r.earningsRouted, destination_received: r.destinationReceived,
    exposure_before: r.exposureBefore, exposure_after: r.exposureAfter,
    preserved: r.preserved, verification: r.verification, verification_note: r.verificationNote ?? null,
    created_at: r.createdAt,
  });
  if (error) {
    // Retry-safe if the same intent already produced a receipt.
    if (String(error.message).toLowerCase().includes('duplicate')) {
      const { data } = await db.from('receipts').select('*').eq('intent_id', r.intentId).maybeSingle();
      if (data) return fromDbReceipt(data);
    }
    throw error;
  }
  return r;
}

function toDbRule(r: Rule) {
  return {
    id: r.id, wallet: r.wallet, kind: r.kind, source_symbol: r.sourceSymbol,
    destination_symbol: r.destinationSymbol, destination_mint: r.destinationMint,
    min_execution_usd: r.minExecutionUsd, max_slippage_bps: r.maxSlippageBps, status: r.status,
    principal_floor_usd: r.principalFloorUsd ?? null,
    principal_floor_source: r.principalFloorSource ?? null,
    safety_buffer_usd: r.safetyBufferUsd ?? null,
    vault_address: r.vaultAddress ?? null,
    vault_shares_baseline: r.vaultSharesBaseline ?? null,
    dividend_raw_baseline: r.dividendRawBaseline ?? null,
    dividend_source_decimals: r.dividendSourceDecimals ?? null,
    baseline_event_id: r.baselineEventId ?? null,
    created_at: r.createdAt,
  };
}

function fromDbRule(x: any): Rule {
  return {
    id: x.id, wallet: x.wallet, kind: x.kind, sourceSymbol: x.source_symbol,
    destinationSymbol: x.destination_symbol, destinationMint: x.destination_mint,
    minExecutionUsd: Number(x.min_execution_usd), maxSlippageBps: Number(x.max_slippage_bps ?? 50),
    status: x.status,
    principalFloorUsd: x.principal_floor_usd == null ? undefined : Number(x.principal_floor_usd),
    principalFloorSource: x.principal_floor_source ?? undefined,
    safetyBufferUsd: x.safety_buffer_usd == null ? undefined : Number(x.safety_buffer_usd),
    vaultAddress: x.vault_address ?? undefined,
    vaultSharesBaseline: x.vault_shares_baseline ?? undefined,
    dividendRawBaseline: x.dividend_raw_baseline ?? undefined,
    dividendSourceDecimals: x.dividend_source_decimals == null ? undefined : Number(x.dividend_source_decimals),
    baselineEventId: x.baseline_event_id,
    createdAt: x.created_at,
  };
}

function fromDbReceipt(x: any): Receipt {
  return {
    id: x.id, wallet: x.wallet, ruleId: x.rule_id, intentId: x.intent_id, signature: x.signature,
    title: x.title, kind: x.kind, sourceBefore: x.source_before, sourceAfter: x.source_after,
    earningsRouted: x.earnings_routed, destinationReceived: x.destination_received,
    exposureBefore: x.exposure_before, exposureAfter: x.exposure_after, preserved: x.preserved,
    verification: x.verification, verificationNote: x.verification_note ?? undefined,
    createdAt: x.created_at,
  };
}
