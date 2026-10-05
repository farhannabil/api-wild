'use client';
import {useEffect,useState} from 'react';
import {Activity,KeyRound,CreditCard,UserRound,Building2,Users,ShieldCheck,SlidersHorizontal,Plug,ArrowUpRight,Layers} from 'lucide-react';
import {supabaseBrowser} from '@/lib/supabase-browser';
import {customerProfileData,watchCustomerIdentity} from '@/lib/customer-profile';
import OwnedPlayground from '@/app/console/owned-playground';
import WorkspacePolicy from '@/app/console/workspace-policy';
import {MessageSquare,Code2,Search} from 'lucide-react';
import Billing from '@/app/console/billing-client';
import OwnedKeys from '@/app/console/owned-keys';
import OwnedUsage from '@/app/console/owned-usage';
import Onboarding from '@/app/onboarding/onboarding-client';
const nav=[['Overview','overview',Activity],['Models','models',Layers],['Chat','chat',MessageSquare],['Usage','usage',Activity],['API keys','api-keys',KeyRound],['Credits','billing',CreditCard],['Account','profile',UserRound]] as const;
const destination=(page:string)=>page==='models'?'/models':'/console/'+page;
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
},[retry]);async function signout(){try{const client=await supabaseBrowser();const{error}=await client.auth.signOut({scope:'local'});if(error)throw error;location.assign('/login')}catch(e){setError((e as Error).message||'Sign out failed. Please retry.')}}const title=nav.find(x=>x[1]===section)?.[0]||(['code','research'].includes(section)?'Chat':'Account');const profile=account?.profile,extra=customerProfileData(profile??null);return <main id="main" className="customer-console"><aside className="console-sidebar"><div><span className="sidebar-caption">WORKSPACE</span>{nav.map(([n,p,I])=><a className={(section===p||p==='chat'&&['code','research'].includes(section))?'active':''} href={destination(p)} key={p}><I size={17}/>{n}</a>)}</div><button className="sidebar-signout" onClick={signout}>Sign out ↗</button></aside><section className="console-content"><nav className="console-mobile-links" aria-label="Account sections">{nav.map(([n,p])=><a key={p} className={section===p?'active':''} href={destination(p)}>{n}</a>)}<button onClick={signout}>Sign out</button></nav><div className="console-title"><div><span className="section-overline">YOUR API WILD WORKSPACE</span><h1>{title}</h1><p>Your models, profile and next steps. All together.</p></div><a className="text-link" href="/models">Explore models <ArrowUpRight size={15}/></a></div>{loading?<p role="status" className="console-loading">Loading your workspace…</p>:error?<div role="alert" className="form-error">{error}<button onClick={()=>setRetry(v=>v+1)}>Retry</button></div>:section==='api-keys'?<OwnedKeys/>:section==='billing'?<Billing/>:section==='usage'?<OwnedUsage/>:section==='overview'?<><section className="console-panel"><h2>Your API WILD account</h2><p>Signed in as {account.email}.</p><p>Your available credits and usage are shown below.</p><a href="/console/profile">Account settings</a></section><OwnedUsage/></>:['chat','code','research'].includes(section)?<OwnedPlayground key={section} mode={section as 'chat'|'code'|'research'}/>:['guardrails','members','roles','provider-keys'].includes(section)?<><WorkspacePolicy section="guardrails"/><a href="/console/profile">Account settings</a></>:!profile?.onboarding_completed_at?<div className="console-empty"><Layers/><h2>Let’s set up your workspace.</h2><p>Complete your profile to save your customer preferences.</p><a className="pill-button outline" href="/onboarding">Complete onboarding</a></div>:section==='profile'||section==='organization'?<><WorkspacePolicy section="guardrails"/><Onboarding email={account.email} editing/></>:<div className="console-panel"><h2>{title}</h2><p className="muted">This feature is not available yet. You can browse the model catalog and manage your profile.</p><span className="subtle-chip">Not activated</span></div>}</section></main>}
