import { NextRequest, NextResponse } from 'next/server';
import { listRules } from '@/lib/repository';
import { evaluateRule } from '@/lib/engine';
export async function POST(req:NextRequest){try{const {wallet,ruleId}=await req.json();const rule=(await listRules(wallet)).find(r=>r.id===ruleId);if(!rule)return NextResponse.json({error:'rule not found'},{status:404});return NextResponse.json(await evaluateRule(rule));}catch(e:any){return NextResponse.json({error:e.message},{status:500});}}
