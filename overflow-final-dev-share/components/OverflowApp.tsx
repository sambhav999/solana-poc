'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Rule, Receipt, ExecutionIntent } from '@/lib/types';

declare global { interface Window { solana?: { isPhantom?:boolean; connect:()=>Promise<{publicKey:{toString():string}}>; signTransaction:(tx:any)=>Promise<any> } } }
const DESTS=[{symbol:'SPYx'},{symbol:'QQQx'},{symbol:'NVDAx'}];
function short(s:string){return s?`${s.slice(0,4)}…${s.slice(-4)}`:''}
export default function OverflowApp(){
 const [wallet,setWallet]=useState(''); const [rules,setRules]=useState<Rule[]>([]); const [receipts,setReceipts]=useState<Receipt[]>([]); const [kind,setKind]=useState<'XSTOCK_DIVIDEND'|'KAMINO_INTEREST'>('XSTOCK_DIVIDEND'); const [source,setSource]=useState('MRKx'); const [dest,setDest]=useState(DESTS[0]); const [principal,setPrincipal]=useState(10000); const [threshold,setThreshold]=useState(5); const [status,setStatus]=useState(''); const [intent,setIntent]=useState<ExecutionIntent|null>(null); const [replay,setReplay]=useState<any>(null); const [guards,setGuards]=useState<any>(null); const [slippage,setSlippage]=useState(50);
 async function connect(){try{if(!window.solana)throw new Error('Install Phantom/Solflare-compatible wallet');const x=await window.solana.connect();setWallet(x.publicKey.toString())}catch(e:any){setStatus(e.message)}}
 async function refresh(w=wallet){if(!w)return;const [r,c]=await Promise.all([fetch(`/api/rules?wallet=${w}`).then(x=>x.json()),fetch(`/api/receipts?wallet=${w}`).then(x=>x.json())]);setRules(r.rules||[]);setReceipts(c.receipts||[])}
 useEffect(()=>{refresh()},[wallet]);
 async function createRule(){if(!wallet)return setStatus('Connect wallet first');setStatus('Creating rule…');const body:any={wallet,kind,sourceSymbol:kind==='KAMINO_INTEREST'?'USDC':source,destinationSymbol:dest.symbol,minExecutionUsd:threshold,maxSlippageBps:slippage};if(kind==='KAMINO_INTEREST'){body.principalFloorUsd=principal;body.principalFloorSource='USER_CONFIRMED';if(process.env.NEXT_PUBLIC_KAMINO_USDC_VAULT) body.vaultAddress=process.env.NEXT_PUBLIC_KAMINO_USDC_VAULT}const r=await fetch('/api/rules',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(x=>x.json());if(r.error)setStatus(r.error);else{setStatus('Rule activated ✓');await refresh()}}
 async function evaluate(rule:Rule){
  setStatus('Evaluating earnings…'); setIntent(null); setGuards(null);
  const r=await fetch('/api/engine/evaluate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet,ruleId:rule.id})}).then(x=>x.json());
  if(r.error) return setStatus(r.error);
  setGuards(r.guards||null);
  if(!r.ready) return setStatus(`${r.status}: ${r.reason||'Not ready'}`);
  setIntent(r.intent);
  setStatus('Earnings isolated. Review and sign to execute.');
 }

 async function signAndSend(txB64:string){
  const bytes=Uint8Array.from(atob(txB64),c=>c.charCodeAt(0));
  const web3=await import('@solana/web3.js');
  const tx=web3.VersionedTransaction.deserialize(bytes);
  const signed=await window.solana!.signTransaction(tx);
  return btoa(String.fromCharCode(...signed.serialize()));
 }

 /**
  * Interest rules are two signatures: withdraw the isolated interest from Kamino,
  * then swap what actually landed. Skipping step one would swap the wallet's own
  * USDC, which is exactly what this product promises never to do.
  */
 async function executeIntent(){
  if(!intent||!wallet||!window.solana) return;
  try{
   let currentIntent=intent;

   if(intent.reason==='INTEREST' && intent.state==='PREPARED'){
    setStatus('Step 1 of 2 — withdrawing isolated interest from Kamino…');
    const w=await fetch('/api/kamino/prepare-withdraw',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intentId:intent.id})}).then(x=>x.json());
    if(w.error) throw new Error(w.error);
    if(!w.alreadyWithdrawn){
      const signedWithdraw=await signAndSend(w.transaction);
      const sent=await fetch('/api/execution/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intentId:intent.id,signedTransaction:signedWithdraw})}).then(x=>x.json());
      if(sent.error) throw new Error(sent.error);
      currentIntent=sent.intent||currentIntent;
    }else{
      currentIntent=w.intent||currentIntent;
    }
    setStatus('Withdrawal verified. Preparing route for the exact USDC that landed…');
   }

   setStatus(currentIntent.reason==='INTEREST'?'Step 2 of 2 — routing verified earnings to '+currentIntent.destinationSymbol+'…':'Getting best Jupiter route…');
   const p=await fetch('/api/execution/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intentId:currentIntent.id})}).then(x=>x.json());
   if(p.error) throw new Error(p.error);
   const txB64=p.order.transaction||p.order.swapTransaction;
   if(!txB64) throw new Error('Jupiter returned no transaction');
   const signedSwap=await signAndSend(txB64);

   setStatus('Submitting signed transaction and verifying source preservation…');
   const x=await fetch('/api/jupiter/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intentId:currentIntent.id,signedTransaction:signedSwap,requestId:p.order.requestId})}).then(r=>r.json());
   if(x.error) throw new Error(x.error);
   setStatus(x.receipt?.verification==='VERIFIED_ON_CHAIN'
    ? `Executed and verified on chain ✓ ${x.signature}`
    : `Executed, but preservation could NOT be verified — see receipt. ${x.signature}`);
   setIntent(null); setGuards(null); await refresh();
  }catch(e:any){ setStatus(e.message) }
 }

 async function toggleRule(r:Rule){
  await fetch('/api/rules',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:r.id,status:r.status==='ACTIVE'?'PAUSED':'ACTIVE'})});
  await refresh();
 }
 async function runReplay(){setStatus('Loading historical corporate action…');const r=await fetch('/api/replay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:source})}).then(x=>x.json());if(r.error)setStatus(r.error);else{setReplay(r);setStatus('Replay loaded — historical, not live.')}}
 const active=useMemo(()=>rules.filter(r=>r.status==='ACTIVE').length,[rules]);
 return <main className="shell"><header className="top"><div className="brand"><div className="logo"/><div><h1>OVERFLOW</h1><div className="tag">PROGRAMMABLE EARNINGS</div></div></div><button className="wallet" onClick={connect}>{wallet?short(wallet):'Connect Solana Wallet'}</button></header>
 <section className="hero"><div><h2>Keep the source.<br/>Program the earnings.</h2><p>Overflow isolates the economic output generated by an onchain asset and routes only those earnings into the destination you choose.</p><div className="row" style={{justifyContent:'flex-start'}}><span className="pill">xStocks dividends</span><span className="pill">Kamino interest</span><span className="pill gold">Jupiter execution</span></div></div><div className="heroCard"><div className="muted">ACTIVE RULES</div><div className="metric">{active}</div><div className="divider"/><div className="muted">EXECUTION MODEL</div><strong>Non-custodial · User signed</strong></div></section>
 <div className="grid"><section className="panel"><h3>Your Earnings Rules</h3>{!rules.length&&<div className="muted">Connect wallet and activate your first rule.</div>}{rules.map(r=><div className="rule" key={r.id}><div className="row"><div className="ruleTitle">{r.sourceSymbol}</div><span className="pill">{r.status}</span></div><div className="path">{r.kind==='XSTOCK_DIVIDEND'?'Dividend':'Interest'} → {r.destinationSymbol}</div><div className="row"><span className="muted">Execute ≥ ${r.minExecutionUsd}</span><span style={{display:'flex',gap:8}}><button className="btn secondary" onClick={()=>toggleRule(r)}>{r.status==='ACTIVE'?'Pause':'Resume'}</button><button className="btn secondary" onClick={()=>evaluate(r)}>Check earnings</button></span></div></div>)}</section>
 <section className="panel"><h3>Create Earnings Rule</h3><div className="form"><div className="field"><label>WHEN</label><select value={kind} onChange={e=>setKind(e.target.value as any)}><option value="XSTOCK_DIVIDEND">my xStock receives a dividend</option><option value="KAMINO_INTEREST">my Kamino USDC earns interest</option></select></div>{kind==='XSTOCK_DIVIDEND'?<div className="field"><label>SOURCE</label><input value={source} onChange={e=>setSource(e.target.value)} /></div>:<div className="field"><label>KEEP PRINCIPAL FLOOR (USDC)</label><input type="number" value={principal} onChange={e=>setPrincipal(Number(e.target.value))}/></div>}<div className="field"><label>SEND EARNINGS TO</label><select value={dest.symbol} onChange={e=>setDest(DESTS.find(x=>x.symbol===e.target.value)||DESTS[0])}>{DESTS.map(x=><option key={x.symbol}>{x.symbol}</option>)}</select></div><div className="field"><label>EXECUTE WHEN EARNINGS EXCEED</label><input type="number" value={threshold} onChange={e=>setThreshold(Number(e.target.value))}/></div><div className="field"><label>MAX SLIPPAGE (BPS)</label><input type="number" value={slippage} onChange={e=>setSlippage(Number(e.target.value))}/></div><button className="btn" onClick={createRule}>Activate Rule</button></div></section>
 {intent&&<section className="panel full"><div className="row"><h3>Execution Review</h3><span className="pill gold">READY FOR SIGNATURE</span></div><div className="grid" style={{marginTop:0}}><div><div className="muted">SOURCE</div><strong>{intent.sourceSymbol}</strong><div className="muted" style={{marginTop:12}}>EARNINGS ISOLATED</div><div className="metric" style={{fontSize:24}}>{intent.rawAmount} raw units</div></div><div><div className="muted">DESTINATION</div><strong>{intent.destinationSymbol}</strong><div className="success" style={{marginTop:12}}>Preservation invariant checked ✓</div>{intent.withdraw&&<div className="muted" style={{marginTop:8}}>Two signatures: withdraw {intent.withdraw.tokenAmount} USDC of interest, then route it. Principal floor stays in the vault.</div>}<div className="muted" style={{marginTop:8}}>Max slippage {intent.maxSlippageBps} bps</div></div></div><div className="divider"/><button className="btn" onClick={executeIntent}>{intent.reason==='INTEREST'?'Sign withdrawal, then swap':'Review & sign Jupiter swap'}</button></section>}
 <section className="panel"><div className="row"><h3>Dividend Replay Mode</h3><span className="pill gold">HISTORICAL</span></div><p className="muted">Use a real historical xStocks corporate action when no live dividend falls inside the judging window. Replay is explicitly labelled and never represented as live.</p><button className="btn secondary" onClick={runReplay}>Load {source} historical dividend</button>{replay&&<div className="receipt"><strong>{replay.label}</strong><div className="status">Multiplier {replay.m0} → {replay.m1}</div><div className="status">Dividend-created raw exposure: {replay.rawDividendAtomic}</div><div className={replay.preserved?'success':'error'}>Original economic exposure preserved {replay.preserved?'✓':'✕'}</div></div>}</section>
 <section className="panel"><h3>Overflow Receipts</h3>{!receipts.length&&<div className="muted">Successful executions will appear here with their Solana transaction proof.</div>}{receipts.slice(0,5).map(r=><div className="receipt" key={r.id}><strong>{r.title}</strong><div className="status">Earnings routed: {r.earningsRouted}</div><div className="status">Source {r.sourceBefore} → {r.sourceAfter}</div><div className="status">Exposure {r.exposureBefore} → {r.exposureAfter}</div><div className={r.preserved?'success':'error'}>{r.verification==='VERIFIED_ON_CHAIN'?'Source preserved — verified on chain ✓':r.verification==='FAILED'?'Preservation NOT verified ✕':'Unverified'}</div>{r.verificationNote&&<div className="muted">{r.verificationNote}</div>}{r.signature&&<a href={`https://solscan.io/tx/${r.signature}`} target="_blank" className="success">View Solana transaction ↗</a>}</div>)}</section>
 </div>{(status||guards)&&<div className="panel" style={{marginTop:18}}><strong>STATUS</strong><div className="status">{status}</div>{guards&&<div className="row" style={{flexWrap:'wrap',gap:8,marginTop:10}}>{Object.entries(guards).map(([k,v]:any)=><span key={k} className="pill" style={{opacity:v?1:.45}}>{v?'✓':'•'} {k}</span>)}</div>}</div>}<footer className="footer">OVERFLOW · The programmable earnings layer for onchain assets</footer></main>}
