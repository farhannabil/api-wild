'use client';
import {useEffect,useState} from 'react';
import {supabaseBrowser} from '@/lib/supabase-browser';

export function AuthForm({mode}:{mode:'login'|'signup'|'forgot'|'reset'|'verify'}){
 const[email,setEmail]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{let active=true;setReady(false);setError('');(async()=>{const client=await supabaseBrowser();const {data:{session},error}=await client.auth.getSession();if(error)throw error;if(!active)return;if(mode==='reset'){if(!session)throw Error('Your reset link has expired. Request a new password reset email.');setReady(true);return}if(session&&mode!=='forgot'&&mode!=='verify'){location.replace('/console/overview');return}setReady(true)})().catch(e=>active&&setError(e.message||'Sign-in could not be loaded. Please retry.'));return()=>{active=false}},[mode,retry]);
 async function submit(event:React.FormEvent){event.preventDefault();setBusy(true);setError('');setNotice('');try{const client=await supabaseBrowser();const cleanEmail=email.trim();
  if(mode==='verify'){const{error}=await client.auth.resend({type:'signup',email:cleanEmail,options:{emailRedirectTo:location.origin+'/auth/complete'}});if(error)throw error;setNotice('If your account needs confirmation, a new email is on its way. Open the latest link in your inbox.');}
  else if(mode==='forgot'){const{error}=await client.auth.resetPasswordForEmail(cleanEmail,{redirectTo:location.origin+'/auth/complete?flow=recovery'});if(error)throw error;setNotice('If an account exists for this email, you’ll receive a link to reset your password.');}
  else if(mode==='reset'){if(password!==confirm)throw Error('Your passwords do not match.');const{error}=await client.auth.updateUser({password});if(error)throw error;setPassword('');setConfirm('');setNotice('Your password has been updated. You can return to your workspace.');}
  else if(mode==='signup'){const{data,error}=await client.auth.signUp({email:cleanEmail,password,options:{emailRedirectTo:location.origin+'/auth/complete'}});if(error)throw error;if(data.session)location.assign('/onboarding');else{setPassword('');setNotice('Check your inbox for an API WILD confirmation email. Follow the link to finish creating your account. If you already have an account, sign in.');}}
  else{const{error}=await client.auth.signInWithPassword({email:cleanEmail,password});if(error)throw error;location.assign('/console/overview');}
 }catch(e){setError((e as Error).message||'Unable to continue. Please try again.')}finally{setBusy(false)}}
 async function resend(){if(!email.trim()){setError('Enter your email address first.');return}setBusy(true);setError('');try{const client=await supabaseBrowser();const{error}=await client.auth.resend({type:'signup',email:email.trim(),options:{emailRedirectTo:location.origin+'/auth/complete'}});if(error)throw error;setNotice('If your account is awaiting confirmation, a new email is on its way.')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <form className="console-form" onSubmit={submit}>
  {mode!=='reset'&&<label>Email address<input type="email" required maxLength={254} autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></label>}
  {mode!=='forgot'&&mode!=='verify'&&<label>{mode==='reset'?'New password':'Password'}<input type="password" required minLength={mode==='login'?1:8} maxLength={128} autoComplete={mode==='login'?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/>{mode!=='login'&&<small>Use at least 8 characters.</small>}</label>}
  {mode==='reset'&&<label>Confirm new password<input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={busy}/></label>}
  {mode==='login'&&<div className="auth-tools"><a href="/forgot-password">Forgot password?</a></div>}
  {error&&<div className="form-error" role="alert">{error}{!ready&&<button type="button" className="auth-text-button auth-retry" onClick={()=>setRetry(v=>v+1)}>Retry connection</button>}{mode==='reset'&&<a href="/forgot-password"> Request a new link</a>}</div>}
  {notice&&<p className="info-banner" role="status">{notice}{mode==='reset'&&<a href="/console/overview"> Open workspace →</a>}</p>}
  <button className="pill-button dark" disabled={busy||!ready}>{busy?'Please wait…':!ready?(error?'Sign-in unavailable':'Connecting…'):{login:'Sign in →',signup:'Create account →',forgot:'Send reset link →',reset:'Save new password →',verify:'Send confirmation email →'}[mode]}</button>
  {(mode==='login'||(notice&&mode==='signup'))&&<p><button type="button" className="auth-text-button" disabled={busy} onClick={resend}>Resend confirmation email</button></p>}
 </form>
}
