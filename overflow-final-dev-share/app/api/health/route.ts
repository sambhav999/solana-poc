import { NextResponse } from 'next/server';
import { persistenceMode } from '@/lib/repository';

export async function GET() {
  try {
    const production = process.env.NODE_ENV === 'production';
    const persistence = persistenceMode();
    const required = {
      solanaRpc: Boolean(process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL),
      xstocks: Boolean(process.env.XSTOCKS_API_BASE),
      kaminoVault: Boolean(process.env.KAMINO_USDC_VAULT),
      supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    };
    const ok = Object.values(required).every(Boolean) && (!production || persistence === 'supabase');
    return NextResponse.json({ ok, production, persistence, required }, { status: ok ? 200 : 503 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
  }
}
