import { NextRequest, NextResponse } from 'next/server';import { listReceipts } from '@/lib/repository';
export async function GET(req:NextRequest){const wallet=req.nextUrl.searchParams.get('wallet');if(!wallet)return NextResponse.json({error:'wallet required'},{status:400});return NextResponse.json({receipts:await listReceipts(wallet)});}
