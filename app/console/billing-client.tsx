'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {CreditCard,ExternalLink,RefreshCw} from 'lucide-react';
import {supabaseBrowser} from '@/lib/supabase-browser';
import {forgetCheckoutRequest,forgetFinishedCheckoutRequests} from '@/lib/billing-checkout';
type BillingData={balance:{cents:number};availableCents:number;holdCents:number;enabled:boolean;portalEnabled:boolean;mode:string;packs:Record<string,number>;entries:{id:string;amount_cents:number;description:string;created_at:string}[];orders:{id:string;request_id:string;pack:string;amount_cents:number;status:string;created_at:string}[]};
const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
async function api(path:string,body?:unknown){
  const client=await supabaseBrowser(),{data:{session}}=await client.auth.getSession();
  if(!session)throw Error('Your session expired. Sign in again to manage billing.');
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+session.access_token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(25000)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Billing is temporarily unavailable.');return data;
}
export default function Billing(){
  const[data,setData]=useState<BillingData|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState('');
  const lock=useRef(false);
  const load=useCallback(async()=>{const next=await api('/api/billing') as BillingData;forgetFinishedCheckoutRequests(next.orders,sessionStorage);setData(next);},[]);
  const confirm=useCallback(async(sessionId:string)=>{
    const result=await api('/api/billing/reconcile',{sessionId});
    setNotice(result.status==='paid'?'Payment confirmed. Your credits have been added.':result.status==='refunded'?'This payment was fully refunded. Your balance reflects the refund.':result.status==='partially_refunded'?'This payment was partially refunded. Your balance reflects the refund.':result.status==='expired'?'This checkout expired. You can start a new purchase.':'Your payment is still being confirmed. Refresh billing shortly.');
    if(['paid','partially_refunded','refunded','expired'].includes(result.status))history.replaceState({},'',location.pathname);
  },[]);
  useEffect(()=>{let active=true;(async()=>{const params=new URLSearchParams(location.search);if(params.has('cancelled'))setNotice('Checkout was closed. Refresh billing to check your latest payment status.');const id=params.get('session_id');if(id)await confirm(id);if(active)await load();})().catch(e=>active&&setError(e.message));return()=>{active=false}},[load,confirm]);
  async function action(name:string,fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(name);setError('');try{await fn()}catch(e){setError((e as Error).message)}finally{lock.current=false;setBusy('')}}
  async function checkout(pack:string){let requestId=sessionStorage.getItem('apiwild-checkout-'+pack);if(!requestId){requestId=crypto.randomUUID();sessionStorage.setItem('apiwild-checkout-'+pack,requestId);}const result=await api('/api/billing/checkout',{pack,requestId});location.assign(result.url);}
  return <>
    {error&&<div className="form-error" role="alert">{error} <button onClick={()=>action('refresh',load)}>Retry</button> <a href="/login">Sign in</a></div>}
    {notice&&<div className="billing-notice" role="status">{notice}</div>}
    {!data&&!error?<p role="status">Loading billing…</p>:data&&<>
      <div className="billing-toolbar"><span className="subtle-chip">{data.mode==='test'?'Test mode · no real money':'USD · prepaid credits'}</span><button className="pill-button outline" disabled={!!busy} onClick={()=>action('refresh',async()=>{const id=new URLSearchParams(location.search).get('session_id');if(id)await confirm(id);await load()})}><RefreshCw size={16}/> Refresh</button></div>
      <div className="metrics-grid"><article className="metric-card"><small>Available credit</small><strong>{money(data.availableCents)}</strong><span>USD{data.mode==='test'?' · test balance':''}</span></article><article className="metric-card"><small>Account balance</small><strong>{money(data.balance.cents)}</strong><span>Purchases less refunds</span></article><article className="metric-card"><small>Payment review</small><strong>{money(data.holdCents)}</strong><span>Held while a dispute is unresolved or lost</span></article></div>
      {!data.enabled&&<div className="billing-notice">Credit purchases are not available yet. You will not be charged.</div>}
      {data.holdCents>0&&<div className="form-error">A disputed payment affects your available credit. <a href="mailto:support@apiwild.com">Contact billing support</a>.</div>}
      <section className="console-panel"><h2>Add credits</h2><p className="muted">One-time purchases in USD. Any applicable tax is shown at checkout. No recurring subscription.</p><div className="billing-packs">{Object.entries(data.packs).map(([pack,cents])=><article className="billing-pack" key={pack}><span>{pack[0].toUpperCase()+pack.slice(1)}</span><h3>{money(cents)}</h3><p>Prepaid API WILD credit</p><button className="pill-button dark" disabled={!data.enabled||!!busy||data.holdCents>0} onClick={()=>action(pack,()=>checkout(pack))}><CreditCard size={16}/>{busy===pack?'Opening checkout…':'Add '+money(cents)}</button></article>)}</div><p className="muted billing-footnote">Payments are processed by Stripe. API WILD never receives your full card details. <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></section>
      <section className="console-panel"><div className="billing-toolbar"><div><h2>Invoices & billing details</h2><p className="muted">View invoices and update your billing information securely.</p></div><button className="pill-button outline" disabled={!data.portalEnabled||!!busy} onClick={()=>action('portal',async()=>{const result=await api('/api/billing/portal',{});location.assign(result.url)})}>Manage billing <ExternalLink size={16}/></button></div></section>
      <section className="console-panel"><h2>Transactions</h2>{data.entries.length?<div className="billing-table-wrap"><table className="console-table"><thead><tr><th>Date</th><th>Description</th><th>Amount (USD)</th></tr></thead><tbody>{data.entries.map(e=><tr key={e.id}><td>{new Date(e.created_at).toLocaleDateString()}</td><td>{e.description}</td><td>{money(e.amount_cents)}</td></tr>)}</tbody></table></div>:<p className="muted">Your verified purchases and refunds will appear here.</p>}</section>
      <section className="console-panel"><h2>Checkout history</h2>{data.orders.length?data.orders.map(o=><div className="setting-row" key={o.id}><div><strong>{money(o.amount_cents)}</strong><p>{new Date(o.created_at).toLocaleDateString()} · {o.status.replaceAll('_',' ')}</p></div>{['paid','partially_refunded','refunded'].includes(o.status)?<button className="text-link" disabled={!!busy} onClick={()=>action(o.id,async()=>{const result=await api('/api/billing/receipt?orderId='+encodeURIComponent(o.id));location.assign(result.url)})}>View receipt <ExternalLink size={14}/></button>:<button className="text-link" disabled={!!busy} onClick={()=>{forgetCheckoutRequest(o,sessionStorage);setNotice('Ready for a new checkout. Choose a credit pack above.')}}>Start a new checkout</button>}</div>):<p className="muted">No checkouts yet.</p>}</section>
    </>}
  </>;
}
