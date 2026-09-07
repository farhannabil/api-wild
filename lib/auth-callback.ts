import type {EmailOtpType, SupabaseClient} from '@supabase/supabase-js';

export function hasAuthLink(href:string){
  const url=new URL(href), hash=new URLSearchParams(url.hash.slice(1));
  const strong=['access_token','refresh_token','token_hash'].some(k=>url.searchParams.has(k)||hash.has(k));
  const authPath=['/','/login','/signup','/auth/complete','/reset-password','/verify-email'].includes(url.pathname);
  return strong||authPath&&['code','error','error_code','error_description'].some(k=>url.searchParams.has(k)||hash.has(k));
}

export async function finishAuthLink(client:SupabaseClient,href:string){
  const url=new URL(href),query=url.searchParams,fragment=new URLSearchParams(url.hash.slice(1));
  const value=(key:string)=>query.get(key)||fragment.get(key);
  if(['error','error_code','error_description'].some(key=>value(key)))throw Error('This email link has expired or was already used. Request a new email below.');
  let recovery=query.get('flow')==='recovery'||value('type')==='recovery';
  const tokenHash=query.get('token_hash'),code=query.get('code'),access=fragment.get('access_token'),refresh=fragment.get('refresh_token');
  if(tokenHash){
    const type=query.get('type');
    if(!type||!['email','signup','recovery','invite','magiclink','email_change'].includes(type))throw Error('This email link is incomplete. Please request a new one.');
    const {error}=await client.auth.verifyOtp({token_hash:tokenHash,type:type as EmailOtpType});if(error)throw error;
  }else if(code){
    const flowId=query.get('sb_flow_id');
    const {data,error}=await client.auth.exchangeCodeForSession(code,flowId?{flowId}:undefined);
    if(error)throw Error('We could not verify this link. Open it in the browser where you requested it, or request a new email.');
    recovery ||= 'redirectType' in data&&data.redirectType==='recovery';
  }else if(access||refresh){
    if(!access||!refresh)throw Error('This email link is incomplete. Please request a new one.');
    const {error}=await client.auth.setSession({access_token:access,refresh_token:refresh});if(error)throw error;
  }
  const {data:{session},error}=await client.auth.getSession();if(error)throw error;
  if(!session)throw Error('This link has expired or was already used. Sign in or request a new email.');
  const {data:{user},error:userError}=await client.auth.getUser();
  if(userError||!user)throw Error('Your session could not be verified. Please sign in again.');
  if(!user.email_confirmed_at)throw Error('Your email still needs to be confirmed. Request a new confirmation email.');
  return recovery?'/reset-password':'/onboarding';
}
