'use client';
import {useEffect,useRef,useState} from 'react';
import {customerApi} from '@/lib/customer-api';
const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
export default function PromoCredit({onRedeemed}:{onRedeemed:()=>Promise<void>}){
 const[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[history,setHistory]=useState<{id:string;amount_cents:number;created_at:string}[]>([]);const lock=useRef(false);
 async function load(){const data=await customerApi('/api/billing/promos');if(!Array.isArray(data.redemptions))throw Error('Promo history is unavailable.');setHistory(data.redemptions);}
 useEffect(()=>{load().catch(()=>setError('Promo history could not load. You can still try a code.'));},[]);
 async function redeem(e:React.FormEvent){e.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');try{
  const result=await customerApi('/api/billing/promo',{method:'POST',body:JSON.stringify({code:code.trim()})});
  if(result.redeemed!==true||!Number.isSafeInteger(result.amountCents)||result.amountCents<=0)throw Error('Redemption could not be confirmed. Refresh your balance before trying again.');
  setNotice(result.replayed?`This code already added ${money(result.amountCents)}. Your balance was not charged or credited again.`:`${money(result.amountCents)} added to your API WILD credits. Your confirmation email is queued.`);setCode('');
  await Promise.all([load(),onRedeemed()]).catch(()=>setError('Credits were confirmed, but the balance display could not refresh. Please refresh the page.'));
 }catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}}
 return <section className="console-panel promo-credit"><div><span className="console-eyebrow">A little extra fuel</span><h2>Have a promo code?</h2><p>Redeem it straight into your API WILD balance. No card or checkout needed.</p></div><form onSubmit={redeem} className="promo-code-form"><label htmlFor="credit-promo">Promo code</label><div><input id="credit-promo" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={48} placeholder="Enter your code" value={code} disabled={busy} onChange={e=>setCode(e.target.value)}/><button className="pill-button dark" disabled={busy||!/^[A-Za-z0-9_-]{4,48}$/.test(code.trim())}>{busy?'Redeeming…':'Redeem credits'}</button></div></form>{error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="billing-notice" role="status">{notice}</p>}{history.length>0&&<details><summary>Promo credit history · {history.length}</summary>{history.map(row=><div className="setting-row" key={row.id}><strong>+{money(row.amount_cents)}</strong><span>{new Date(row.created_at).toLocaleString()}</span></div>)}</details>}</section>;
}
