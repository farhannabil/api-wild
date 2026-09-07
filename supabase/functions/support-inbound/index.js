import { createHandler } from './core.mjs';
import template from './template.mjs';

const env=name=>Deno.env.get(name);
const key=env('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(env('SUPABASE_SECRET_KEYS')||'{}').default;
const resendKey=env('RESEND_API_KEY');
const secret=env('RESEND_WEBHOOK_SECRET');
const api=async(url,options={})=>{
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw Error('upstream_unavailable');
  return response.json();
};
const rpc=(name,body)=>api(`${env('SUPABASE_URL')}/rest/v1/rpc/${name}`,{
  method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)
});
const db={
  claim:(id,hash,payload,reason)=>rpc('claim_support_delivery',{p_email_id:id,p_sender_hash:hash,p_payload:payload,p_reason:reason}),
  complete:(id,lease,sent)=>rpc('complete_support_delivery',{p_email_id:id,p_lease_id:lease,p_resend_id:sent}),
  healthy:async()=>{
    if (!key || !resendKey) return false;
    const rows=await api(`${env('SUPABASE_URL')}/rest/v1/support_deliveries?select=state&or=(state.eq.review,and(state.eq.processing,first_attempt_at.lt.${encodeURIComponent(new Date(Date.now()-30*60*1000).toISOString())}))&limit=1`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});
    return rows.length===0;
  }
};
const provider={
  receive:id=>api(`https://api.resend.com/emails/receiving/${id}`,{headers:{Authorization:`Bearer ${resendKey}`}}),
  send:(payload,idempotencyKey)=>api('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:`Bearer ${resendKey}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify(payload)
  })
};
Deno.serve(createHandler({secret,enabled:env('SUPPORT_AUTOREPLY_ENABLED')==='true',db,provider,template}));
