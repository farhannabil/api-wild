'use client';

import {createClient, type SupabaseClient} from '@supabase/supabase-js';

let clientPromise:Promise<SupabaseClient>|null=null;

export function supabaseBrowser(){
  if(!clientPromise)clientPromise=fetch('/api/supabase-config',{cache:'no-store',signal:AbortSignal.timeout(15000)})
    .then(async response=>{
      const config=await response.json().catch(()=>{throw Error('Sign-in could not connect. Please try again in a moment.');});
      if(!response.ok||!config.url||!config.publishableKey)throw Error(config.error||'Customer sign-in is temporarily unavailable.');
      return createClient(config.url,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
    }).catch(error=>{clientPromise=null;throw error;});
  return clientPromise;
}
