 'use client';
import {useEffect,useState} from 'react';
import {supabaseBrowser} from '@/lib/supabase-browser';
import {finishAuthLink} from '@/lib/auth-callback';
import {ApiWildBrand} from '@/app/api-wild-brand';
let completion:Promise<string>|null=null;
export default function Complete(){
 const [error,setError]=useState(''),[manual,setManual]=useState(false),[busy,setBusy]=useState(true),[slow,setSlow]=useState(false),[recovery,setRecovery]=useState(false);
 function complete(){setBusy(true);setManual(false);if(!completion){const href=location.href;completion=(async()=>{try{return await finishAuthLink(await supabaseBrowser(),href)}finally{history.replaceState(history.state,'','/auth/complete')}})()}return completion;}
 function start(){complete().then(path=>location.replace(path)).catch(e=>{setError(e instanceof Error&&e.message?e.message:'We could not finish signing you in. Request a new email below.');setBusy(false)});}
 useEffect(()=>{const url=new URL(location.href);setRecovery(url.searchParams.get('type')==='recovery'||url.searchParams.get('flow')==='recovery');if(url.searchParams.has('token_hash')){setManual(true);setBusy(false)}else start()},[]);
 useEffect(()=>{if(!busy)return;const timer=setTimeout(()=>setSlow(true),15000);return()=>clearTimeout(timer)},[busy]);
 return <main id="main" className="auth-callback"><ApiWildBrand/><span className="section-overline">ACCOUNT VERIFICATION</span><h1>{error?'Let’s get you back in.':manual?(recovery?'Reset your password.':'Confirm your email.'):'Opening your workspace…'}</h1>{error?<><p role="alert">{error}</p><div className="callback-actions"><a className="pill-button dark" href="/verify-email">Send a new confirmation</a><a className="pill-button outline" href="/login">Sign in</a></div><a href="/forgot-password">Reset your password</a></>:manual?<><p>{recovery?'Continue securely to choose a new password for your API WILD account.':'Confirm this email address to continue to your API WILD account.'}</p><button className="pill-button dark" onClick={start}>{recovery?'Continue to password reset →':'Confirm and continue →'}</button></>:<p role="status">Verifying your secure link…</p>}<noscript>JavaScript is required to complete verification. Enable it, then reopen your email link.</noscript>{busy&&<p className="auth-fine">{slow?<>This is taking longer than expected. You can <a href="/login">sign in</a> or <a href="/verify-email">request another email</a>.</>:"Please keep this page open."}</p>}</main>
}
