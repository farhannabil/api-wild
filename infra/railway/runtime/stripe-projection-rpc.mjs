// SERVER ONLY. One fixed financial RPC; no credential discovery, order registry,
// arbitrary SQL, retries, seeding or production activation. Explicit injection.
import {SUPABASE_ORIGIN, strictObject, exactInteger, withDeadline} from './supabase-gateway-rpc.mjs';
import {STRIPE_ACCOUNTS, PROJECTION_RPC, StripeProjectionError} from './stripe-financial-projection.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENTS=Object.freeze({
  checkout:['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed'],
  refund:['charge.refunded','refund.created','refund.updated','refund.failed'],
  dispute:['charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated'],
});
const FIELDS=Object.freeze({
  checkout:['order_id','session_id','customer_id','payment_intent','currency','subtotal_cents','total_cents','tax_cents','discount_cents','status','payment_status'],
  refund:['order_id','customer_id','payment_intent','currency','received_cents','refunded_cents'],
  dispute:['order_id','customer_id','payment_intent','currency','dispute_id','amount_cents','status'],
});
const PARAMS=['p_account_id','p_billing_mode','p_event_id','p_event_type','p_event_digest','p_event_created','p_operation','p_fact'];
const fail=(code='stripe_rpc_unavailable',status=503)=>{throw new StripeProjectionError(code,status);};
function shape(raw,fields){strictObject(raw,fields);if(fields.some(f=>!Object.hasOwn(raw,f)))fail('stripe_rpc_invalid_input',400);return raw;}
function text(raw,pattern,max=128){if(typeof raw!=='string'||raw.length>max||!pattern.test(raw))fail('stripe_rpc_invalid_input',400);return raw;}
function cents(raw,min=0){return exactInteger(raw,min,200000000);}
function secretKey(value){
  if(typeof value!=='string'||value.length>8192)fail('stripe_rpc_invalid_configuration');
  if(/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(value))return {value,legacy:false};
  if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))fail('stripe_rpc_invalid_configuration');
  let claims;try{claims=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8'));}catch{fail('stripe_rpc_invalid_configuration');}
  // Shape only. The fixed remote authenticates the JWT; this is not a JWT proof.
  if(claims?.role!=='service_role'||claims?.ref!=='yautmilnpllojugpmfgy')fail('stripe_rpc_invalid_configuration');
  return {value,legacy:true};
}
function parameters(raw,mode,account){
  shape(raw,PARAMS);
  if(raw.p_account_id!==account||raw.p_billing_mode!==mode||!Object.hasOwn(EVENTS,raw.p_operation)
    ||!EVENTS[raw.p_operation].includes(raw.p_event_type))fail('stripe_rpc_invalid_input',400);
  text(raw.p_event_id,/^evt_[A-Za-z0-9]+$/);text(raw.p_event_digest,/^[a-f0-9]{64}$/,64);exactInteger(raw.p_event_created);
  const fact=shape(raw.p_fact,FIELDS[raw.p_operation]);
  text(fact.order_id,UUID,36);text(fact.customer_id,/^cus_[A-Za-z0-9]+$/);
  if(fact.currency!=='usd')fail('stripe_rpc_invalid_input',400);
  if(fact.payment_intent!==null||raw.p_operation!=='checkout')text(fact.payment_intent,/^pi_[A-Za-z0-9]+$/);
  if(raw.p_operation==='checkout'){
    text(fact.session_id,new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$'));
    cents(fact.subtotal_cents,1);cents(fact.total_cents,1);cents(fact.tax_cents);
    if(fact.discount_cents!==0||fact.total_cents!==fact.subtotal_cents+fact.tax_cents
      ||!['open','complete','expired'].includes(fact.status)||!['paid','unpaid','no_payment_required'].includes(fact.payment_status)
      ||(fact.status==='complete'&&fact.payment_status==='paid'&&fact.payment_intent===null))fail('stripe_rpc_invalid_input',400);
  }else if(raw.p_operation==='refund'){
    cents(fact.received_cents,1);cents(fact.refunded_cents);
    if(fact.refunded_cents>fact.received_cents)fail('stripe_rpc_invalid_input',400);
  }else{
    text(fact.dispute_id,/^dp_[A-Za-z0-9]+$/);cents(fact.amount_cents,1);
    if(!['needs_response','under_review','won','lost','warning_needs_response','warning_under_review','warning_closed','prevented'].includes(fact.status))fail('stripe_rpc_invalid_input',400);
  }
  // A scalar, caller-independent snapshot before any await. No getters/toJSON.
  return {...raw,p_fact:{...fact}};
}
function cancel(response){try{void response?.body?.cancel().catch(()=>{});}catch{}}
async function receipt(response,url,signal,expected){
  if(signal.aborted||!response?.ok||!(response.headers instanceof Headers)||response.redirected
    ||(response.url&&response.url!==url)||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')){
    cancel(response);fail();
  }
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>4096)){cancel(response);fail();}
  const reader=response.body?.getReader();if(!reader)fail();
  const abort=()=>{try{void reader.cancel().catch(()=>{});}catch{}};
  signal.addEventListener('abort',abort,{once:true});let count=0;const chunks=[];
  try{
    while(true){
      if(signal.aborted)fail('stripe_rpc_deadline_exceeded');
      const {done,value}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array)||(count+=value.byteLength)>4096){abort();fail();}chunks.push(value);
    }
    if(signal.aborted)fail('stripe_rpc_deadline_exceeded');
    let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,count)));shape(result,['applied','replayed','event_id','operation']);}catch{fail();}
    if(result.applied!==true||typeof result.replayed!=='boolean'||result.event_id!==expected.p_event_id||result.operation!==expected.p_operation)fail();
    return Object.freeze({...result});
  }finally{signal.removeEventListener('abort',abort);try{reader.releaseLock();}catch{}}
}

export function createStripeProjectionRpc(config={}){
  strictObject(config,['enabled','supabaseOrigin','secretKey','billingMode','accountId','fetchImpl','timeoutMs']);
  if(config.enabled!==undefined&&typeof config.enabled!=='boolean')fail('stripe_rpc_invalid_configuration');
  if(config.enabled!==true)return async()=>fail('stripe_projection_disabled');
  if(config.supabaseOrigin!==SUPABASE_ORIGIN||!['live','test'].includes(config.billingMode)
    ||config.accountId!==STRIPE_ACCOUNTS[config.billingMode])fail('stripe_rpc_invalid_configuration');
  const secret=secretKey(config.secretKey),mode=config.billingMode,account=config.accountId;
  const fetchImpl=config.fetchImpl??globalThis.fetch,timeout=exactInteger(config.timeoutMs??12000,1,25000);
  if(typeof fetchImpl!=='function')fail('stripe_rpc_invalid_configuration');
  const url=SUPABASE_ORIGIN+'/rest/v1/rpc/'+PROJECTION_RPC;
  return async(name,raw,options={})=>{
    let snapshot,parent;
    try{
      if(name!==PROJECTION_RPC)fail('stripe_rpc_invalid_input',400);
      strictObject(options,['signal']);parent=options.signal;
      if(parent!==undefined&&!(parent instanceof AbortSignal))fail('stripe_rpc_invalid_input',400);
      snapshot=parameters(raw,mode,account);
    }catch(error){if(error instanceof StripeProjectionError)throw error;fail('stripe_rpc_invalid_input',400);}
    if(parent?.aborted)fail('stripe_rpc_deadline_exceeded');
    const body=JSON.stringify(snapshot);if(Buffer.byteLength(body)>8192)fail('stripe_rpc_invalid_input',400);
    const headers={apikey:secret.value,'content-type':'application/json',accept:'application/json','content-profile':'public'};
    if(secret.legacy)headers.authorization='Bearer '+secret.value;
    try{return await withDeadline(async deadline=>{
      const signal=parent?AbortSignal.any([deadline,parent]):deadline;
      let onAbort;
      const aborted=new Promise((_,reject)=>{onAbort=()=>reject(new StripeProjectionError('stripe_rpc_deadline_exceeded'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
      const work=async()=>{
        if(signal.aborted)fail('stripe_rpc_deadline_exceeded');
        const response=await fetchImpl(url,{method:'POST',headers,body,signal,redirect:'error',cache:'no-store'});
        if(signal.aborted){cancel(response);fail('stripe_rpc_deadline_exceeded');}
        return receipt(response,url,signal,snapshot);
      };
      try{return await Promise.race([work(),aborted]);}finally{signal.removeEventListener('abort',onAbort);}
    },timeout);}catch(error){
      if(error?.code==='gateway_deadline_exceeded'||error?.code==='stripe_rpc_deadline_exceeded')fail('stripe_rpc_deadline_exceeded');
      fail(); // Never echo database/error bodies or keys. Ambiguous outcomes retry only through Stripe's same event.
    }
  };
}
