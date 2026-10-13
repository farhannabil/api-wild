'use client';
import {useEffect,useState} from 'react';
import {customerApi} from '@/lib/customer-api';
import {watchWallet} from '@/lib/owned-wallet-poll.mjs';
import {walletMoney as money} from './use-owned-wallet';
type Counts={requests:number;inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;cacheReadKnown:number;cacheWriteKnown:number;chargedUsdMicros:number;pendingRequests:number};
type Dashboard={currency:string;windowDays:number;timezone:string;refreshedAt:string|null;totals:Counts;days:(Counts&{day:string})[];models:{model:string;requests:number;chargedUsdMicros:number}[];billingCheck:{checkedAt:string;mismatches:number;overdueRequests:number;staleKeys:number}|null};
const number=(n:number)=>n.toLocaleString();
export default function UsageCharts(){
 const[data,setData]=useState<Dashboard|null>(null),[error,setError]=useState(false);
 useEffect(()=>watchWallet({document,window,read:async signal=>{
  const value=await customerApi('/api/usage/details',{signal});
  if(value.currency!=='USD'||value.windowDays!==30||!Array.isArray(value.days)||!Array.isArray(value.models)||!value.totals)throw Error('Invalid usage');
  return value as Dashboard;
 },onValue:value=>{setData(value);setError(false)},onError:()=>setError(true)}),[]);
 const colours=['#6366f1','#10b981','#f59e0b','#ec4899'];
 const series=[['inputTokens','Reported input'],['outputTokens','Output'],['cacheReadTokens','Cache read'],['cacheWriteTokens','Cache write']] as const;
 const cache=(count:number,known:number)=>known?`${number(count)}${known<data!.totals.requests?' (reported subtotal)':''}`:'Not reported';
 const maxTokens=data?Math.max(1,...data.days.flatMap(d=>series.map(([key])=>d[key]))):1;
 const maxSpend=data?Math.max(1,...data.days.map(d=>d.chargedUsdMicros)):1;
 const warning=data?.billingCheck&&(data.billingCheck.mismatches+data.billingCheck.overdueRequests+data.billingCheck.staleKeys)>0;
 return <section className="console-panel"><h2>Usage trends · last 30 days</h2>
 {error&&<p role="status">Usage charts could not refresh. Previously displayed data may be out of date.</p>}
 {!data?<p>Loading recorded token usage…</p>:<>
 <p>Updated {data.refreshedAt?new Date(data.refreshedAt).toLocaleString():'pending first refresh'} · Hourly refresh · UTC days</p>
 {data.refreshedAt&&Date.now()-Date.parse(data.refreshedAt)>75*60000&&<p role="status">The hourly dashboard refresh is delayed.</p>}
 {warning&&<p role="status">Some usage is awaiting reconciliation or a billing check needs attention. Your available credit above includes pending holds.</p>}
 <div className="metrics-grid">{[['Reported input tokens',number(data.totals.inputTokens)],['Output tokens',number(data.totals.outputTokens)],['Cache read tokens',cache(data.totals.cacheReadTokens,data.totals.cacheReadKnown)],['Cache write tokens',cache(data.totals.cacheWriteTokens,data.totals.cacheWriteKnown)],['Settled charges · 30 days',money(data.totals.chargedUsdMicros)],['Pending requests',number(data.totals.pendingRequests)]].map(([label,value])=><article className="metric-card" key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>
 <p>Charges use actual supplier cost × 5. Token counts are unchanged. Cache reporting varies by provider and may overlap reported input; these categories are not added into an inflated total. Missing cache details are not treated as zero.</p>
 {data.days.length===0?<p>No recorded usage in this period. Charts will populate after requests sync.</p>:<>
 <h3>Daily tokens</h3><div style={{display:'flex',gap:16,flexWrap:'wrap'}}>{series.map(([,label],i)=><span key={label} style={{color:colours[i]}}>{label}</span>)}</div>
 <svg viewBox={`0 0 ${Math.max(320,data.days.length*44)} 170`} role="img" aria-label="Daily reported input, output, cache read and cache write tokens" style={{width:'100%',maxHeight:240}}>{data.days.map((d,i)=><g key={d.day} transform={`translate(${i*44+8},0)`}>{series.map(([key,label],j)=><rect key={key} x={j*8} y={135-d[key]/maxTokens*120} width={6} height={d[key]/maxTokens*120} fill={colours[j]}><title>{d.day}: {label} {number(d[key])}</title></rect>)}<text x={14} y={155} textAnchor="middle" fontSize={8} fill="currentColor">{d.day.slice(5)}</text></g>)}</svg>
 <h3>Daily settled charges (USD)</h3><svg viewBox={`0 0 ${Math.max(320,data.days.length*44)} 170`} role="img" aria-label="Daily settled customer charges in USD" style={{width:'100%',maxHeight:240}}>{data.days.map((d,i)=><g key={d.day}><rect x={i*44+8} y={135-d.chargedUsdMicros/maxSpend*120} width={28} height={d.chargedUsdMicros/maxSpend*120} fill="#6366f1"><title>{d.day}: {money(d.chargedUsdMicros)}</title></rect><text x={i*44+22} y={155} textAnchor="middle" fontSize={8} fill="currentColor">{d.day.slice(5)}</text></g>)}</svg>
 <details><summary>Daily usage data</summary><div style={{overflowX:'auto'}}><table><thead><tr>{['UTC day','Requests','Input','Output','Cache read','Cache write','Charged USD'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{data.days.map(d=><tr key={d.day}><td>{d.day}</td><td>{number(d.requests)}</td><td>{number(d.inputTokens)}</td><td>{number(d.outputTokens)}</td><td>{d.cacheReadKnown?number(d.cacheReadTokens):'Not reported'}</td><td>{d.cacheWriteKnown?number(d.cacheWriteTokens):'Not reported'}</td><td>{money(d.chargedUsdMicros)}</td></tr>)}</tbody></table></div></details>
 <h3>By model</h3><div style={{overflowX:'auto'}}><table><thead><tr><th>Model</th><th>Requests</th><th>Settled charges</th></tr></thead><tbody>{data.models.map(m=><tr key={m.model}><td>{m.model}</td><td>{number(m.requests)}</td><td>{money(m.chargedUsdMicros)}</td></tr>)}</tbody></table></div>
 </>}
 <p>Billing check: {data.billingCheck?new Date(data.billingCheck.checkedAt).toLocaleString():'pending first check'}. Recent activity can take until the next hourly refresh to appear. Historical charges retain their original billing policy.</p>
 </>}
 </section>;
}
