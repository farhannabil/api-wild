'use client';
import {useEffect,useState} from 'react';
import {Activity,KeyRound,CreditCard,UserRound,Building2,Users,ShieldCheck,SlidersHorizontal,Plug,ArrowUpRight,Layers} from 'lucide-react';
import {supabaseBrowser} from '@/lib/supabase-browser';
import {customerProfileData,watchCustomerIdentity} from '@/lib/customer-profile';
import GatewayClient from '@/app/console/gateway-client';
import RouteCards from '@/app/route-cards';
import {MessageSquare,Code2,Search} from 'lucide-react';
import Billing from '@/app/console/billing-client';
import Onboarding from '@/app/onboarding/onboarding-client';
const nav=[['Overview','overview',Activity],['Chat','chat',MessageSquare],['Code','code',Code2],['Research','research',Search],['Usage','usage',Activity],['API keys','api-keys',KeyRound],['Billing','billing',CreditCard],['Profile','profile',UserRound],['Organization','organization',Building2],['Members','members',Users],['Roles & permissions','roles',ShieldCheck],['Guardrails','guardrails',SlidersHorizontal],['Provider connections','provider-keys',Plug]] as const;
export default function SupabaseConsole({section}:{section:string}){const[account,setAccount]=useState<any>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);useEffect(()=>{
 let live=true,invalidated=false,stopWatching=()=>{};
 setAccount(null);setLoading(true);setError('');
 (async()=>{
  const client=await supabaseBrowser();
  const{data:{session},error:sessionError}=await client.auth.getSession();if(sessionError)throw sessionError;
  if(!live)return;
  if(!session){invalidated=true;location.replace('/login');return;}
  const userId=session.user.id;
  stopWatching=watchCustomerIdentity(client,userId,nextId=>{
   if(!live)return;
   invalidated=true;setAccount(null);setLoading(true);setError('');
   if(nextId)setRetry(v=>v+1);else location.replace('/login');
  });
  const{data:profile,error}=await client.from('customer_profiles').select('full_name,company_name,role,use_case,onboarding_data,onboarding_completed_at').eq('user_id',userId).maybeSingle();if(error)throw error;
  if(live&&!invalidated)setAccount({email:session.user.email||'',profile});
 })().catch(e=>{if(live&&!invalidated)setError(e.message||'Your workspace could not be loaded.');}).finally(()=>{if(live&&!invalidated)setLoading(false);});
 return()=>{live=false;stopWatching();};
},[retry]);async function signout(){try{const client=await supabaseBrowser();const{error}=await client.auth.signOut({scope:'local'});if(error)throw error;location.assign('/login')}catch(e){setError((e as Error).message||'Sign out failed. Please retry.')}}const title=nav.find(x=>x[1]===section)?.[0]||'Workspace';const profile=account?.profile,extra=customerProfileData(profile??null);return <main id="main" className="customer-console"><aside className="console-sidebar"><div><span className="sidebar-caption">WORKSPACE</span>{nav.slice(0,7).map(([n,p,I])=><a className={section===p?'active':''} href={'/console/'+p} key={p}><I size={17}/>{n}</a>)}</div><div><span className="sidebar-caption">ACCOUNT</span>{nav.slice(7).map(([n,p,I])=><a className={section===p?'active':''} href={'/console/'+p} key={p}><I size={17}/>{n}</a>)}</div><button className="sidebar-signout" onClick={signout}>Sign out ↗</button></aside><section className="console-content"><nav className="console-mobile-links" aria-label="Account sections">{nav.map(([n,p])=><a key={p} className={section===p?'active':''} href={'/console/'+p}>{n}</a>)}<button onClick={signout}>Sign out</button></nav><div className="console-title"><div><span className="section-overline">YOUR API WILD WORKSPACE</span><h1>{title}</h1><p>Your models, profile and next steps. All together.</p></div><a className="text-link" href="/models">Explore models <ArrowUpRight size={15}/></a></div>{loading?<p role="status" className="console-loading">Loading your workspace…</p>:error?<div role="alert" className="form-error">{error}<button onClick={()=>setRetry(v=>v+1)}>Retry</button></div>:!profile?.onboarding_completed_at?<div className="console-empty"><Layers/><h2>Let’s set up your workspace.</h2><p>Complete your profile to save your customer preferences.</p><a className="pill-button outline" href="/onboarding">Complete onboarding</a></div>:section==='profile'||section==='organization'?<Onboarding email={account.email} editing/>:section==='billing'?<Billing/>:['chat','code','research','usage','api-keys','guardrails','provider-keys'].includes(section)?<GatewayClient key={section} section={section}/>:section==='overview'?<><div className="welcome-panel"><div><span className="section-overline">BUILT AROUND YOU</span><h2>Welcome, {profile.full_name}.</h2><p>{profile.company_name} · {profile.use_case}</p><a href="/console/chat" className="pill-button dark">Open Chat →</a></div></div><div className="metrics-grid"><article className="metric-card"><small>Account</small><strong>Active</strong><span>{account.email}</span></article><article className="metric-card"><small>Planning budget</small><strong>${Number(extra.budget||0).toLocaleString()}</strong><span>Monthly preference</span></article><article className="metric-card"><small>Customer data</small><strong>Saved</strong><span>Profile and preferences</span></article></div><RouteCards/></>:<div className="console-panel"><h2>{title}</h2><p className="muted">This feature is not available yet. You can browse the model catalog and manage your profile.</p><span className="subtle-chip">Not activated</span></div>}</section></main>}
