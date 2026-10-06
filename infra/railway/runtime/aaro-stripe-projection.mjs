// Signed canonical AARO subscription facts only. No browser success, manual
// credit seed, legacy D1 import or API WILD USD funding enters this adapter.
import {createHash} from 'node:crypto';
import catalog from '../../../lib/aaro-plans.json' with {type:'json'};
import {verifyStripeSignature,boundedJson,STRIPE_ACCOUNTS,StripeProjectionError} from './stripe-financial-projection.mjs';
import {strictObject,exactInteger,withDeadline} from './supabase-gateway-rpc.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const types=new Set(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','invoice.paid','invoice.payment_failed','invoice.payment_action_required','invoice.voided','invoice.marked_uncollectible','checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed','charge.refunded','refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated','radar.early_fraud_warning.created']);
const fail=(code='aaro_stripe_unverified',status=503)=>{throw new StripeProjectionError(code,status);};
const objectId=x=>typeof x==='string'?x:x?.id;
const id=(x,prefix)=>{x=objectId(x);if(typeof x!=='string'||!new RegExp('^'+prefix+'_[A-Za-z0-9]+$').test(x))fail();return x;};
const money=x=>exactInteger(x,0,200000000);
function list(x,max=100){if(x?.object!=='list'||x.has_more!==false||!Array.isArray(x.data)||x.data.length>max)fail();return x.data;}
export function createAaroStripeProjection(config={}){
 strictObject(config,['enabled','billingMode','accountId','stripeSecretKey','webhookSecret','fetchImpl','rpc','timeoutMs','nowSeconds']);
 if(config.enabled!==true)return Object.freeze({handle:async()=>fail('aaro_stripe_disabled')});
 const mode=config.billingMode,account=config.accountId,key=config.stripeSecretKey,secret=config.webhookSecret;
 if(!['live','test'].includes(mode)||account!==STRIPE_ACCOUNTS[mode]||typeof key!=='string'||!new RegExp('^(sk|rk)_'+mode+'_[A-Za-z0-9]+$').test(key)
  ||typeof secret!=='string'||!/^whsec_[A-Za-z0-9]{16,256}$/.test(secret)||typeof config.rpc!=='function')fail();
 const fetcher=config.fetchImpl??fetch,rpc=config.rpc,now=config.nowSeconds??(()=>Math.floor(Date.now()/1000));
 const checkMode=x=>{if(x?.livemode!==(mode==='live'))fail('aaro_stripe_mode_mismatch');};
 const read=async(path,signal)=>{
  const url='https://api.stripe.com/v1/'+path;
  return boundedJson(await fetcher(url,{method:'GET',headers:{authorization:'Bearer '+key,accept:'application/json','stripe-version':'2026-08-26.dahlia'},redirect:'error',cache:'no-store',signal}),url,signal);
 };
 const binding=async(subscription,checkout,signal)=>{
  const value=await rpc('aaro_stripe_binding_read_v1',{p_subscription:subscription??null,p_checkout:checkout??null},{signal});
  if(value?.binding===null)return null;
  const b=value?.binding,plan=catalog.plans.find(plan=>plan.id===b?.plan_reference);
  if(!b||!UUID.test(b.id)||!plan||b.owner!==mode+':supabase:'+b.owner?.split(':')[2]||!UUID.test(b.owner?.split(':')[2]??'')
   ||!/^cus_[A-Za-z0-9]+$/.test(b.customer_id)||b.plan?.id!==plan.id||b.plan?.amount!==plan.amount||b.plan?.credits!==plan.credits
   ||b.plan?.priceId!==plan.priceId||b.plan?.productId!==plan.productId||b.plan?.currency!==plan.currency
   ||(plan.region==='BD'&&value.bangladeshEligible!==true))fail('aaro_stripe_binding_unverified');
  return {b,plan};
 };
 const subscription=async(ref,signal)=>{
  const sub=await read('subscriptions/'+id(ref,'sub'),signal);checkMode(sub);
  if(sub.id!==objectId(ref))fail();
  // Resolve native Subscription ownership first. Legacy metadata is an explicit
  // fallback only when an invoice arrives before checkout completion.
  const checkout=typeof sub.metadata?.aaro_checkout==='string'&&UUID.test(sub.metadata.aaro_checkout)?sub.metadata.aaro_checkout:null;
  const bound=await binding(sub.id,checkout,signal);if(!bound)return null;
  const {b,plan}=bound,item=list(sub.items,1)[0];
  if(!item||item.quantity!==1||objectId(sub.customer)!==b.customer_id||(b.subscription_id!==null&&b.subscription_id!==sub.id)
   ||item.price?.id!==plan.priceId||item.price.currency!==plan.currency||item.price.unit_amount!==plan.amount
   ||item.price.recurring?.interval!=='month'||item.price.recurring.interval_count!==1||item.price.type!=='recurring'
   ||objectId(item.price.product)!==plan.productId||sub.pause_collection!==null&&sub.pause_collection!==undefined)fail();
  const price=await read('prices/'+plan.priceId,signal);checkMode(price);
  if(price.id!==plan.priceId||price.active!==true||price.currency!==plan.currency||price.unit_amount!==plan.amount||price.type!=='recurring'
   ||price.recurring?.interval!=='month'||price.recurring.interval_count!==1||objectId(price.product)!==plan.productId)fail();
  const product=await read('products/'+plan.productId,signal);checkMode(product);
  if(product.id!==plan.productId||product.active!==true||product.metadata?.brand!=='aaro'||product.metadata.plan!==plan.id||product.metadata.credits!==String(plan.credits))fail();
  if(!['active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused','trialing'].includes(sub.status))fail();
  return {...bound,sub,fact:{product:'aaro',checkoutId:b.id,customerId:b.customer_id,subscriptionId:sub.id,planReference:plan.id,priceId:plan.priceId,currency:plan.currency,amount:plan.amount,subscriptionStatus:sub.status}};
 };
 const invoice=async(ref,signal)=>{
  const inv=await read('invoices/'+id(ref,'in'),signal);checkMode(inv);if(inv.id!==objectId(ref))fail();
  const subRef=objectId(inv.parent?.subscription_details?.subscription);if(!subRef)return null;
  const bound=await subscription(subRef,signal);if(!bound)return null;
  if(objectId(inv.customer)!==bound.b.customer_id||inv.currency!==bound.plan.currency)fail();
  return {...bound,inv};
 };
 const processorPaid=async(bound,signal)=>{
  const {inv,plan,b}=bound;
  if(plan.amount===0)return inv.total===0&&inv.amount_paid===0;
  const payments=list(await read('invoice_payments?invoice='+inv.id+'&status=paid&limit=100',signal),20),seen=new Set(),charges=new Set();let total=0n;
  if(!payments.length)fail();
  for(const p of payments){
   checkMode(p);id(p.id,'inpay');if(seen.has(p.id)||objectId(p.invoice)!==inv.id||p.status!=='paid'||p.currency!==plan.currency||money(p.amount_paid)===0)fail();seen.add(p.id);total+=BigInt(p.amount_paid);
   let charge,chargeReference;
   if(p.payment?.type==='payment_intent'){
    const pi=await read('payment_intents/'+id(p.payment.payment_intent,'pi'),signal);checkMode(pi);
    if(pi.id!==objectId(p.payment.payment_intent)||pi.status!=='succeeded'||objectId(pi.customer)!==b.customer_id||pi.currency!==plan.currency||money(pi.amount_received)<p.amount_paid)fail();
    chargeReference=id(pi.latest_charge,'ch');charge=await read('charges/'+chargeReference,signal);
   }else if(p.payment?.type==='charge'){chargeReference=id(p.payment.charge,'ch');charge=await read('charges/'+chargeReference,signal);}
   else fail();
   checkMode(charge);
   if(charge.id!==chargeReference||charges.has(charge.id)||p.payment.type==='payment_intent'&&objectId(charge.payment_intent)!==objectId(p.payment.payment_intent)
    ||objectId(charge.customer)!==b.customer_id||charge.currency!==plan.currency||charge.status!=='succeeded'||charge.paid!==true||charge.captured!==true
    ||charge.disputed!==false||money(charge.amount_refunded)!==0||money(charge.amount)<p.amount_paid)fail();
   charges.add(charge.id);
   // Pending refunds also hold fulfillment. Complete canonical lists only.
   const refunds=list(await read('refunds?charge='+id(charge.id,'ch')+'&limit=100',signal));
   const refundIds=new Set();for(const refund of refunds){id(refund.id,'re');if(refundIds.has(refund.id)||objectId(refund.charge)!==charge.id||refund.currency!==plan.currency)fail();refundIds.add(refund.id);if(!['failed','canceled'].includes(refund.status))fail('aaro_payment_under_review');}
  }
  if(total!==BigInt(money(inv.total)))fail();return true;
 };
 return Object.freeze({async handle(input){
  strictObject(input,['rawBody','signature']);
  if(!(input.rawBody instanceof Uint8Array)||input.rawBody.byteLength<1||input.rawBody.byteLength>1000000)fail('aaro_invalid_envelope',400);
  const body=Buffer.from(input.rawBody);
  if(!verifyStripeSignature(body,input.signature,secret,exactInteger(now())))fail('aaro_invalid_signature',400);
  let event;try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{fail('aaro_invalid_envelope',400);}
  id(event?.id,'evt');checkMode(event);if(event.account!==undefined&&event.account!==account)fail();
  if(!types.has(event.type))fail('aaro_unsupported_event',422);
  const eventDigest=createHash('sha256').update(body).digest('hex');
  try{return await withDeadline(async signal=>{
   const identity=await read('account',signal);if(identity.id!==account)fail();
   let operation,fact;
   if(event.type.startsWith('customer.subscription.')){
    const bound=await subscription(event.data?.object?.id,signal);if(!bound)return {received:true,ignored:true};operation='subscription';fact=bound.fact;
   }else if(event.type.startsWith('invoice.')){
    const bound=await invoice(event.data?.object?.id,signal);if(!bound)return {received:true,ignored:true};
    const {inv,plan}=bound;operation='invoice';fact={...bound.fact,invoiceId:inv.id,paid:false,processorVerified:false};
    if(event.type==='invoice.paid'&&inv.status==='paid'&&bound.sub.status==='active'){
     const line=list(inv.lines,1)[0];
     if(!line||!['subscription_create','subscription_cycle'].includes(inv.billing_reason)||line.quantity!==1||line.parent?.subscription_item_details?.proration===true
      ||objectId(line.pricing?.price_details?.price)!==plan.priceId||money(line.amount)!==plan.amount||money(inv.subtotal)!==plan.amount
      ||money(inv.amount_remaining)!==0||money(inv.amount_paid)!==money(inv.total)||inv.total<plan.amount
      ||!Array.isArray(inv.total_discount_amounts)||inv.total_discount_amounts.some(x=>money(x.amount)!==0)
      ||inv.pre_payment_credit_notes_amount!==0||inv.post_payment_credit_notes_amount!==0||inv.starting_balance!==0)fail();
     const periodStart=exactInteger(line.period?.start,1,Number.MAX_SAFE_INTEGER),periodEnd=exactInteger(line.period?.end,1,Number.MAX_SAFE_INTEGER);
     if(periodEnd<=periodStart||periodEnd-periodStart>32*86400)fail();
     fact={...fact,paid:true,processorVerified:await processorPaid(bound,signal),periodStart,periodEnd};
    }
   }else if(event.type.startsWith('checkout.')){
    const s=await read('checkout/sessions/'+id(event.data?.object?.id,'cs_'+mode),signal);checkMode(s);
    if(s.id!==event.data.object.id||s.mode!=='subscription'||!UUID.test(s.client_reference_id)||s.metadata?.aaro_checkout!==s.client_reference_id||!['open','complete','expired'].includes(s.status))fail();
    const bound=await binding(null,s.client_reference_id,signal);if(!bound)return {received:true,ignored:true};
    if(objectId(s.customer)!==bound.b.customer_id||(bound.b.session_id!==null&&bound.b.session_id!==s.id))fail();
    operation='checkout';fact={product:'aaro',checkoutId:bound.b.id,customerId:bound.b.customer_id,sessionId:s.id,status:s.status};
   }else{
    let source,charge,sourceReference=event.data?.object?.id;
    if(event.type.startsWith('refund.')){source=await read('refunds/'+id(sourceReference,'re'),signal);charge=await read('charges/'+id(source.charge,'ch'),signal);}
    else if(event.type.startsWith('charge.dispute.')){source=await read('disputes/'+id(sourceReference,'dp'),signal);checkMode(source);charge=await read('charges/'+id(source.charge,'ch'),signal);}
    else if(event.type.startsWith('radar.')){source=await read('radar/early_fraud_warnings/'+id(sourceReference,'issfr'),signal);checkMode(source);charge=await read('charges/'+id(source.charge,'ch'),signal);}
    else charge=await read('charges/'+id(sourceReference,'ch'),signal);
    checkMode(charge);if(source&&source.id!==sourceReference||charge.id!==objectId(source?.charge??sourceReference))fail();
    const kind=charge.payment_intent?'payment_intent':'charge',payment=id(charge.payment_intent??charge.id,kind==='charge'?'ch':'pi');
    const params=new URLSearchParams({limit:'100','payment[type]':kind,['payment['+kind+']']:payment});
    const payments=list(await read('invoice_payments?'+params,signal));let held;
    const allocations=new Set();for(const p of payments){
     checkMode(p);id(p.id,'inpay');if(allocations.has(p.id)||p.payment?.type!==kind||objectId(p.payment[kind])!==payment)fail();allocations.add(p.id);
     const bound=await invoice(id(p.invoice,'in'),signal);if(!bound)continue;
     if(held||objectId(charge.customer)!==bound.b.customer_id||charge.currency!==bound.plan.currency)fail('aaro_payment_allocation_review');
     held={...bound.fact,invoiceId:bound.inv.id,sourceReference};
    }
    if(!held)return {received:true,ignored:true};operation='hold';fact=held;
   }
   signal.throwIfAborted();
   const result=await rpc('aaro_stripe_project_v1',{p_account_id:account,p_billing_mode:mode,p_event_id:event.id,p_event_type:event.type,p_digest:eventDigest,p_operation:operation,p_fact:fact},{signal});
   if(result?.applied!==true||result.eventId!==event.id||typeof result.replayed!=='boolean')fail('aaro_projection_unverified');
   return Object.freeze({received:true,replayed:result.replayed});
  },exactInteger(config.timeoutMs??20000,1,25000));}catch(error){if(error instanceof StripeProjectionError)throw error;fail();}
 }});
}
