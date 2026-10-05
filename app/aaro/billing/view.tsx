'use client';
import {useEffect,useState} from 'react';
import {supabaseBrowser} from '@/lib/supabase-browser';
import catalog from '@/lib/aaro-plans.json';
async function api(path:string,body?:unknown){
 const c=await supabaseBrowser(),{data:{session}}=await c.auth.getSession();
 if(!session)throw Error('Sign in to your shared customer account before managing AARO billing.');
 const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+session.access_token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 const data=await r.json();if(!r.ok)throw Error(data.error||'Billing unavailable.');return data;
}
export default function AaroBilling(){
 const [data,setData]=useState<any>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[bd,setBd]=useState(false);
 async function refresh(){try{setData(await api('/api/aaro/billing'));setNotice('');}catch(e){setNotice((e as Error).message);}}
 useEffect(()=>{void refresh();},[]);
 async function checkout(plan:string){setBusy(true);try{const result=await api('/api/aaro/checkout',{plan});location.assign(result.url);}catch(e){setNotice((e as Error).message);setBusy(false);}}
 async function portal(){setBusy(true);try{const result=await api('/api/aaro/portal',{});location.assign(result.url);}catch(e){setNotice((e as Error).message);setBusy(false);}}
 return <>
  <h1>AARO — আরও সম্ভব</h1><p>Monthly plans · মাসিক প্যাকেজ</p>
  <p>AARO credits are separate from API WILD usage credits. Billing uses your shared customer account.</p>
  <p><a href="/login?next=/aaro/billing">Sign in</a> · <a href="/console/billing">API WILD billing</a> · <button className="text-link" onClick={refresh} disabled={busy}>Refresh payment status</button></p>
  {notice&&<p role="alert">{notice}</p>}
  {data&&!data.enabled&&<p role="status">Plan setup is complete. Payment activation is still pending; no charge can be made here yet.</p>}
  <label style={{display:'block',margin:'1.5rem 0'}}><input type="checkbox" checked={bd} onChange={e=>setBd(e.target.checked)}/> Are you in Bangladesh? বাংলাদেশের জন্য বিশেষ মূল্য</label>
  {bd&&<p>Bangladesh prices require verified billing evidence. Selecting this option alone does not qualify an account.</p>}
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'1rem'}}>
   {catalog.plans.filter(p=>p.region===(bd?'BD':'GLOBAL')).map(p=><section className="console-panel" key={p.id}>
    <h2>{p.name}</h2><p style={{fontSize:'1.5rem'}}>{new Intl.NumberFormat(bd?'bn-BD':'en-US',{style:'currency',currency:p.currency.toUpperCase()}).format(p.amount/100)} / {bd?'মাস':'month'}</p>
    <p>{p.displayCredits} {bd?'ক্রেডিট':'credits'} / {bd?'মাস':'month'}</p>
    <button className="pill-button" disabled={busy||!data?.enabled||(bd&&!data?.bangladeshEligible)} onClick={()=>checkout(p.id)}>Choose {p.name}</button>
   </section>)}
  </div>
  <p>Paid plans renew monthly until cancelled. Applicable taxes are shown at checkout. Payment collected by 2740797 Ontario Inc.</p>
  {data?.subscriptions?.length>0&&<section className="console-panel"><h2>Your subscriptions</h2>{data.subscriptions.map((s:any,i:number)=><p key={i}>{catalog.plans.find(p=>p.id===s.plan_id)?.name} — {s.status}</p>)}<button className="pill-button outline" onClick={portal} disabled={busy}>Manage invoices or cancel subscription</button></section>}
  {data?.usage&&<section className="console-panel"><h2>Your AARO credits</h2><p><strong>{data.usage.available.toLocaleString()}</strong> available · {data.usage.spent.toLocaleString()} used · {data.usage.reserved.toLocaleString()} held for requests</p><p>{data.usageEnabled?'Usage is deducted after each confirmed model response.':'Credit spending is awaiting activation.'}</p></section>}
  {data?.creditPeriods?.length>0&&<section className="console-panel"><h2>Verified monthly credit allocations</h2>{data.creditPeriods.map((p:any)=><p key={p.invoice_id}>{p.credits.toLocaleString()} credits · through {new Date(p.period_end*1000).toLocaleDateString()}</p>)}<p>Allocation is confirmed by Stripe. AI usage availability is managed separately.</p></section>}
 </>;
}
