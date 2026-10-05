// SERVER-ONLY, SOURCE-ONLY API WILD USD projection adapter. Nothing is enabled,
// registered, seeded, scheduled or deployed by importing this module.
// Public ingress/verified order registration and real payment acceptance remain
// separate gates. `project` is a trusted fixed-RPC transport, not arbitrary SQL.
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {strictObject, exactInteger, withDeadline} from './supabase-gateway-rpc.mjs';

export const STRIPE_ACCOUNTS = Object.freeze({live:'acct_1UCiHN194XZKj6cF',test:'acct_1UCiHk0SGcPsf6AA'});
export const PROJECTION_RPC = 'apiwild_stripe_project';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHECKOUT=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed'];
const REFUND=['charge.refunded','refund.created','refund.updated','refund.failed'];
const DISPUTE=['charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated'];
const DISPUTE_STATES=['needs_response','under_review','won','lost','warning_needs_response','warning_under_review','warning_closed','prevented'];
const CENT_MAX=200000000, BODY_MAX=1000000;

export class StripeProjectionError extends Error {
  constructor(code,status=503){super(code);this.name='StripeProjectionError';this.code=code;this.status=status;}
}
const fail=(code='stripe_invalid_fact',status=503)=>{throw new StripeProjectionError(code,status);};
function identifier(value,prefix){if(typeof value!=='string'||!new RegExp('^'+prefix+'_[A-Za-z0-9]+$').test(value))fail();return value;}
function cents(value,min=0){if(!Number.isSafeInteger(value)||value<min||value>CENT_MAX)fail();return value;}
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))fail();return value;}

// Same timestamp + HMAC-SHA256 raw-envelope check as lib/billing.ts; Node port
// additionally rejects duplicate timestamps and unsafe integers, and never
// decodes/re-serializes the body before authentication.
export function verifyStripeSignature(raw,header,secret,now=Math.floor(Date.now()/1000)){
  if(!(raw instanceof Uint8Array)||raw.byteLength<1||raw.byteLength>BODY_MAX||typeof header!=='string'||header.length>2048
    ||typeof secret!=='string'||!secret.startsWith('whsec_')||!Number.isSafeInteger(now))return false;
  const parts=header.split(',').map(s=>s.split('='));
  const times=parts.filter(p=>p.length===2&&p[0]==='t');
  if(times.length!==1||!/^\d{1,16}$/.test(times[0][1]))return false;
  const timestamp=Number(times[0][1]);
  if(!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp)>300)return false;
  const expected=createHmac('sha256',secret).update(times[0][1]+'.').update(raw).digest();
  return parts.filter(p=>p.length===2&&p[0]==='v1'&&/^[a-f0-9]{64}$/.test(p[1]))
    .some(p=>timingSafeEqual(expected,Buffer.from(p[1],'hex')));
}

async function boundedJson(response,url,signal){
  const cancel=()=>{try{void response?.body?.cancel().catch(()=>{});}catch{}};
  if(signal.aborted||!response?.ok||response.redirected||(response.url&&response.url!==url)
    ||!/^(?:application\/json)(?:\s*;|$)/i.test(response.headers?.get('content-type')||'')){cancel();fail('stripe_read_unavailable');}
  const length=response.headers?.get('content-length');
  if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>BODY_MAX)){cancel();fail('stripe_response_too_large');}
  const reader=response.body?.getReader();if(!reader)fail('stripe_read_unavailable');
  const abort=()=>{try{void reader.cancel().catch(()=>{});}catch{}};
  signal.addEventListener('abort',abort,{once:true});let count=0;const chunks=[];
  try{
    while(true){
      if(signal.aborted)fail('stripe_deadline_exceeded');
      const {value,done}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array))fail('stripe_read_unavailable');
      count+=value.byteLength;if(count>BODY_MAX){abort();fail('stripe_response_too_large');}chunks.push(value);
    }
    if(signal.aborted)fail('stripe_deadline_exceeded');
    try{return object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,count))));}
    catch{fail('stripe_invalid_response');}
  }finally{signal.removeEventListener('abort',abort);try{reader.releaseLock();}catch{}}
}

export function createStripeFinancialProjection(config){
  strictObject(config,['enabled','billingMode','accountId','stripeSecretKey','webhookSecret','fetchImpl','project','timeoutMs','nowSeconds']);
  const enabled=config.enabled===true;
  if(config.enabled!==undefined&&typeof config.enabled!=='boolean')fail('stripe_invalid_configuration');
  if(!enabled)return Object.freeze({async handle(){fail('stripe_projection_disabled');}});
  const mode=config.billingMode,account=config.accountId,key=config.stripeSecretKey,secret=config.webhookSecret;
  if(!['test','live'].includes(mode)||account!==STRIPE_ACCOUNTS[mode]
    ||typeof key!=='string'||!new RegExp('^(sk|rk)_'+mode+'_[A-Za-z0-9]+$').test(key)
    ||typeof secret!=='string'||!/^whsec_[A-Za-z0-9]{16,256}$/.test(secret)
    ||typeof config.project!=='function')fail('stripe_invalid_configuration');
  const fetchImpl=config.fetchImpl??globalThis.fetch,nowSeconds=config.nowSeconds??(()=>Math.floor(Date.now()/1000));
  if(typeof fetchImpl!=='function'||typeof nowSeconds!=='function')fail('stripe_invalid_configuration');
  const project=config.project,timeoutMs=exactInteger(config.timeoutMs??20000,1,25000);
  const modeCheck=value=>{if(value?.livemode!==(mode==='live'))fail('stripe_mode_mismatch');};
  const read=async(path,signal)=>{
    if(signal.aborted)fail('stripe_deadline_exceeded');
    const url='https://api.stripe.com/v1/'+path;
    const response=await fetchImpl(url,{method:'GET',headers:{authorization:'Bearer '+key,accept:'application/json','stripe-version':'2026-08-26.dahlia'},
      signal,redirect:'error',cache:'no-store'});
    return boundedJson(response,url,signal);
  };
  const payment=async(id,signal)=>{
    identifier(id,'pi');const pi=await read('payment_intents/'+id,signal);
    if(pi.id!==id||pi.status!=='succeeded'||pi.currency!=='usd')fail('stripe_payment_mismatch');modeCheck(pi);
    identifier(pi.customer,'cus');cents(pi.amount_received,1);
    if(typeof pi.metadata?.order_id!=='string'||!UUID.test(pi.metadata.order_id))fail('stripe_order_mismatch');
    return pi;
  };
  const base=pi=>({order_id:pi.metadata.order_id,payment_intent:pi.id,customer_id:pi.customer,currency:pi.currency});
  return Object.freeze({
    async handle(raw){
      strictObject(raw,['rawBody','signature']);
      if(!(raw.rawBody instanceof Uint8Array)||raw.rawBody.byteLength<1||raw.rawBody.byteLength>BODY_MAX)fail('stripe_invalid_envelope',400);
      // Copy caller-owned bytes before any await, avoiding a mutation race.
      const body=Buffer.from(raw.rawBody),now=exactInteger(nowSeconds());
      if(!verifyStripeSignature(body,raw.signature,secret,now))fail('stripe_invalid_signature',400);
      let event;try{event=object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));}catch{fail('stripe_invalid_envelope',400);}
      if(typeof event.id!=='string'||!/^evt_[A-Za-z0-9]+$/.test(event.id)||!Number.isSafeInteger(event.created)||event.created<0
        ||typeof event.type!=='string'||!event.data?.object||typeof event.data.object!=='object'
        ||Array.isArray(event.data.object))fail('stripe_invalid_envelope',400);
      modeCheck(event);
      if(event.account!==undefined&&event.account!==account)fail('stripe_account_mismatch');
      const operation=CHECKOUT.includes(event.type)?'checkout':REFUND.includes(event.type)?'refund':DISPUTE.includes(event.type)?'dispute':null;
      if(!operation)fail('stripe_unsupported_event',422);
      try{return await withDeadline(async signal=>{
        const identity=await read('account',signal);if(identity.id!==account)fail('stripe_account_mismatch');
        let fact;
        if(operation==='checkout'){
          const sessionId=event.data.object.id;
          if(typeof sessionId!=='string'||!new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$').test(sessionId))fail('stripe_invalid_fact');
          const s=await read('checkout/sessions/'+sessionId,signal);modeCheck(s);
          if(s.id!==sessionId||s.mode!=='payment'||s.currency!=='usd'||!UUID.test(s.metadata?.order_id||'')
            ||s.client_reference_id!==s.metadata.order_id||s.metadata?.funding_mode!=='one_time'
            ||!['open','complete','expired'].includes(s.status)||!['paid','unpaid','no_payment_required'].includes(s.payment_status))fail('stripe_order_mismatch');
          identifier(s.customer,'cus');cents(s.amount_subtotal,1);cents(s.amount_total,1);
          object(s.total_details);cents(s.total_details.amount_tax);cents(s.total_details.amount_discount);
          if(s.amount_total!==s.amount_subtotal+s.total_details.amount_tax||s.total_details.amount_discount!==0)fail('stripe_payment_mismatch');
          if(s.payment_intent!==null)identifier(s.payment_intent,'pi');
          if(s.status==='complete'&&s.payment_status==='paid'){
            const pi=await payment(s.payment_intent,signal);
            if(pi.customer!==s.customer||pi.metadata.order_id!==s.metadata.order_id||pi.metadata.funding_mode!=='one_time'
              ||pi.amount_received!==s.amount_total)fail('stripe_payment_mismatch');
          }
          fact={order_id:s.metadata.order_id,session_id:s.id,customer_id:s.customer,payment_intent:s.payment_intent,currency:s.currency,
            subtotal_cents:s.amount_subtotal,total_cents:s.amount_total,tax_cents:s.total_details.amount_tax,discount_cents:0,status:s.status,payment_status:s.payment_status};
        }else if(operation==='refund'){
          const prefix=event.type==='charge.refunded'?'ch':'re',id=identifier(event.data.object.id,prefix);
          const source=await read((prefix==='ch'?'charges/':'refunds/')+id,signal);
          // Refund objects omit livemode; their signed event, account and PaymentIntent bind the mode.
          if(prefix==='ch'||Object.hasOwn(source,'livemode'))modeCheck(source);
          if(source.id!==id||source.currency!=='usd')fail('stripe_invalid_fact');
          const pi=await payment(source.payment_intent,signal);
          if(pi.metadata.funding_mode!=='one_time')fail('stripe_order_mismatch');
          const refunds=await read('refunds?payment_intent='+pi.id+'&limit=100',signal);
          if(refunds.object!=='list'||refunds.has_more!==false||!Array.isArray(refunds.data)||refunds.data.length>100)fail('stripe_refund_review_required');
          let total=0n;const seen=new Set();
          for(const r of refunds.data){
            identifier(r?.id,'re');if(Object.hasOwn(r,'livemode'))modeCheck(r);cents(r.amount,1);
            if(seen.has(r.id)||r.payment_intent!==pi.id||r.currency!==pi.currency
              ||!['pending','requires_action','succeeded','failed','canceled'].includes(r.status))fail('stripe_refund_mismatch');
            seen.add(r.id);if(r.status==='succeeded')total+=BigInt(r.amount);
          }
          if(total>BigInt(pi.amount_received))fail('stripe_refund_mismatch');
          fact={...base(pi),received_cents:pi.amount_received,refunded_cents:Number(total)};
        }else{
          const id=identifier(event.data.object.id,'dp'),d=await read('disputes/'+id,signal);modeCheck(d);
          if(d.id!==id||d.currency!=='usd'||!DISPUTE_STATES.includes(d.status))fail('stripe_invalid_fact');
          const pi=await payment(d.payment_intent,signal);
          if(pi.metadata.funding_mode!=='one_time'||cents(d.amount,1)>pi.amount_received)fail('stripe_dispute_mismatch');
          fact={...base(pi),dispute_id:d.id,amount_cents:d.amount,status:d.status};
        }
        if(signal.aborted)fail('stripe_deadline_exceeded');
        const params=Object.freeze({p_account_id:account,p_billing_mode:mode,p_event_id:event.id,p_event_type:event.type,
          p_event_digest:createHash('sha256').update(body).digest('hex'),p_event_created:event.created,p_operation:operation,p_fact:Object.freeze(fact)});
        const result=await project(PROJECTION_RPC,params,{signal});
        if(signal.aborted)fail('stripe_deadline_exceeded');
        strictObject(result,['applied','replayed','event_id','operation']);
        if(result.applied!==true||typeof result.replayed!=='boolean'||result.event_id!==event.id||result.operation!==operation)fail('stripe_invalid_projection_response');
        return Object.freeze({received:true,replayed:result.replayed});
      },timeoutMs);}catch(error){
        // Never echo upstream bodies, SQL messages, keys or customer data.
        if(error instanceof StripeProjectionError)throw error;
        fail(error?.code==='gateway_deadline_exceeded'?'stripe_deadline_exceeded':'stripe_projection_unavailable');
      }
    },
  });
}
