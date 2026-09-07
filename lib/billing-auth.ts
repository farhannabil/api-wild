import {env} from 'cloudflare:workers';
import {RequestError} from '@/db/service';

// Billing never accepts identity headers or user IDs supplied by the browser.
export async function billingIdentity(request:Request, requireProfile=false){
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer ')||authorization.length>8192)throw new RequestError('Sign in to manage billing.',401);
  if(!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY)throw new RequestError('Customer sign-in is temporarily unavailable.',503);
  const headers={authorization,apikey:env.SUPABASE_PUBLISHABLE_KEY};
  const response=await fetch(env.SUPABASE_URL+'/auth/v1/user',{headers,signal:AbortSignal.timeout(10000)});
  if(response.status===401||response.status===403)throw new RequestError('Your session expired. Sign in again.',401);
  if(!response.ok)throw new RequestError('Sign-in verification is temporarily unavailable.',503);
  const user=await response.json() as {id?:string;email?:string;email_confirmed_at?:string;is_anonymous?:boolean};
  if(!user.id||!user.email||!user.email_confirmed_at||user.is_anonymous)throw new RequestError('Verify your email before using billing.',403);
  if(requireProfile){
    const profile=await fetch(env.SUPABASE_URL+'/rest/v1/customer_profiles?select=onboarding_completed_at&user_id=eq.'+encodeURIComponent(user.id),{headers,signal:AbortSignal.timeout(10000)});
    if(!profile.ok)throw new RequestError('Your profile could not be verified.',503);
    const rows=await profile.json() as {onboarding_completed_at?:string}[];
    if(!rows[0]?.onboarding_completed_at)throw new RequestError('Complete your profile first.',409);
  }
  return {id:'supabase:'+user.id,email:user.email};
}
