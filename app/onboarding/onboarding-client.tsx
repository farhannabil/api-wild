'use client';
import {countryCodes} from '@/lib/countries';
import {useEffect,useRef,useState} from 'react';
import {ArrowRight,Check,Code2,Building2,UserRound,ChevronDown} from 'lucide-react';
import {buildingOptions,complianceOptions} from '@/lib/customer-options';
import {Popover,PopoverTrigger,PopoverContent} from '@/components/ui/popover';
import {Checkbox} from '@/components/ui/checkbox';
import {ApiWildMark} from '@/app/api-wild-brand';
import {onboardingSchema} from '@/lib/onboarding-schema';
import {supabaseBrowser} from '@/lib/supabase-browser';
import {CustomerAccountChangedError,customerProfileData,emptyCustomerProfile,saveCustomerProfile,watchCustomerIdentity} from '@/lib/customer-profile';
const countryNames=new Intl.DisplayNames(['en'],{type:'region'});const countries=[...countryCodes].sort((a,b)=>(countryNames.of(a)||a).localeCompare(countryNames.of(b)||b));
const initial=emptyCustomerProfile;
export default function Onboarding({email:initialEmail='',editing=false}:{email?:string;editing?:boolean}){
 const[data,setData]=useState(initial),[email,setEmail]=useState(initialEmail),[step,setStep]=useState(1),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0),[loadFailed,setLoadFailed]=useState(false);
 const loadedUserId=useRef<string|null>(null);
 useEffect(()=>{
  let live=true,invalidated=false,stopWatching=()=>{};
  loadedUserId.current=null;setLoading(true);setLoadFailed(false);setError('');setNotice('');
  (async()=>{
   const client=await supabaseBrowser();
   const{data:{session},error:sessionError}=await client.auth.getSession();if(sessionError)throw sessionError;
   if(!live)return;
   if(!session){invalidated=true;setData(initial);setEmail('');setLoadFailed(true);location.replace('/login');return;}
   const userId=session.user.id;
   stopWatching=watchCustomerIdentity(client,userId,nextId=>{
    if(!live)return;
    invalidated=true;loadedUserId.current=null;setData(initial);setEmail('');setStep(1);setNotice('');setLoading(true);setLoadFailed(true);
    if(nextId)setRetry(v=>v+1);else location.replace('/login');
   });
   const{data:profile,error}=await client.from('customer_profiles').select('full_name,company_name,role,use_case,onboarding_data').eq('user_id',userId).maybeSingle();if(error)throw error;
   if(live&&!invalidated){loadedUserId.current=userId;setEmail(session.user.email||'');setData(customerProfileData(profile));}
  })().catch(e=>{if(live&&!invalidated){setLoadFailed(true);setError(e.message||'Your saved profile could not be loaded.');}}).finally(()=>{if(live&&!invalidated)setLoading(false);});
  return()=>{live=false;loadedUserId.current=null;stopWatching();};
 },[retry]);
 function set(key:string,value:unknown){setData(current=>({...current,[key]:value}));setNotice('')}
 async function save(event:React.FormEvent){
  event.preventDefault();
  if(saving||loading||loadFailed||!loadedUserId.current)return;
  if(step===1&&!editing){setStep(2);return;}
  const parsed=onboardingSchema.safeParse(data);if(!parsed.success){setError(parsed.error.issues[0]?.message||'Check your profile details.');setStep(1);return;}
  const userId=loadedUserId.current;
  setSaving(true);setError('');
  try{
   const client=await supabaseBrowser();
   if(loadedUserId.current!==userId)return;
   await saveCustomerProfile(client,userId,parsed.data);
   if(loadedUserId.current!==userId)return;
   if(editing)setNotice('Your profile and preferences are saved.');else location.assign('/console/overview');
  }catch(e){
   if(e instanceof CustomerAccountChangedError){loadedUserId.current=null;setData(initial);setEmail('');setStep(1);setLoading(true);setRetry(v=>v+1);}
   else if(loadedUserId.current===userId)setError((e as Error).message||'Your workspace could not be saved. Your entries are still here; please retry.');
  }finally{setSaving(false);}
 }
 return <div className={'customer-onboarding '+(editing?'editing':'')}><form className="onboarding-card console-form" onSubmit={save}><div className="onboarding-title"><ApiWildMark className="onboarding-brand-mark"/><div><h1>{editing?'Your profile':'Welcome to API WILD.'}</h1><p>{editing?'Keep your account details up to date.':'Let’s build your workspace around you.'}</p></div></div>{!editing&&<div className="onboarding-progress"><span className={step===1?'active':''}>01 · Your details</span><span className={step===2?'active':''}>02 · Your goals</span></div>}{loading?<p role="status">Loading your details…</p>:<>{error&&<div className="form-error" role="alert">{error}<button type="button" onClick={()=>setRetry(v=>v+1)}>Reload saved details</button></div>}{notice&&<p className="info-banner" role="status"><Check size={15}/>{notice}</p>}{(step===1||editing)&&<><label>Your name<input required maxLength={100} autoComplete="name" value={data.name} onChange={e=>set('name',e.target.value)}/></label><label>Building for</label><div className="account-type"><button type="button" className={data.accountType==='company'?'selected':''} onClick={()=>set('accountType','company')}><Building2 size={16}/>Company</button><button type="button" className={data.accountType==='personal'?'selected':''} onClick={()=>set('accountType','personal')}><UserRound size={16}/>Personal</button></div><label>{data.accountType==='company'?'Company name':'Project name'}<input required maxLength={120} autoComplete="organization" value={data.company} onChange={e=>set('company',e.target.value)}/></label><div className="form-grid"><label>Company domain <small>Optional</small><input placeholder="yourcompany.com" value={data.domain} maxLength={253} onChange={e=>set('domain',e.target.value)}/></label><label>Phone <small>Optional</small><input type="tel" autoComplete="tel" placeholder="+1…" maxLength={40} value={data.phone} onChange={e=>set('phone',e.target.value)}/></label></div><label>Country<select required value={data.country} onChange={e=>set('country',e.target.value)}><option value="">Select your country</option>{countries.map(c=><option key={c} value={c}>{countryNames.of(c)}</option>)}</select></label></>}{(step===2||editing)&&<><label>What are you building? <small>{data.building.length}/3</small></label><Popover><PopoverTrigger className="building-select" type="button">{data.building.length?data.building.join(', '):'Choose up to 3 use cases'}<ChevronDown size={16}/></PopoverTrigger><PopoverContent className="building-popover" align="start">{buildingOptions.map(x=><label key={x}><Checkbox checked={data.building.includes(x)} disabled={!data.building.includes(x)&&data.building.length===3} onCheckedChange={on=>set('building',on?[...data.building,x]:data.building.filter(v=>v!==x))}/><span>{x}</span></label>)}</PopoverContent></Popover><label>Compliance requirements <small>Optional</small></label><div className="compliance-chips">{complianceOptions.map(x=><button key={x} type="button" aria-pressed={data.compliance.includes(x)} className={data.compliance.includes(x)?'selected':''} onClick={()=>set('compliance',data.compliance.includes(x)?data.compliance.filter(v=>v!==x):[...data.compliance,x])}>{data.compliance.includes(x)&&<Check size={13}/>} {x}</button>)}</div><p className="muted">Tell us your requirements. These selections do not certify compliance or activate a data-retention policy.</p><label>Project <small>Optional</small><textarea maxLength={500} rows={3} placeholder="One line about what you want to achieve" value={data.project} onChange={e=>set('project',e.target.value)}/></label><label>Monthly planning budget (USD)<input type="number" min={0} max={1000000} step={1} required value={data.budget} onChange={e=>set('budget',Number(e.target.value))}/></label></>}<div className="button-row">{step===2&&!editing&&<button type="button" className="pill-button outline" onClick={()=>setStep(1)}>Back</button>}<button className="pill-button dark" disabled={saving||loadFailed}>{saving?'Saving…':editing?'Save profile':step===1?'Continue':'Create my workspace'}<ArrowRight size={16}/></button></div><p className="muted">Signed in as {email}. No payment is taken when saving.</p></>}</form>{!editing&&<aside className="onboarding-preview"><span>YOUR FIRST INTEGRATION</span><div className="code-window"><div className="code-top"><span>READ-ONLY CATALOG</span><Code2 size={15}/></div><pre>{`curl "$API_WILD_ORIGIN/v1/models" \\
  -H "Authorization: Bearer YOUR_API_KEY"`}</pre></div><h2>One clear starting point.</h2><p>Explore the model catalog. Keep your plans and integrations organized.</p><div><p><Check size={16}/> A workspace built around your goals</p><p><Check size={16}/> Your profile and preferences, saved securely</p><p><Check size={16}/> No payment required to create your profile</p></div><small>Catalog browsing is available. External API access, inference and payments are not activated.</small></aside>}</div>
}
