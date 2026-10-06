// AARO subscription Checkout uses its own customer/order RPCs and return domain.
import {createHash,randomUUID} from 'node:crypto';
import catalog from '../../../lib/aaro-plans.json' with {type:'json'};
import {strictObject} from './supabase-gateway-rpc.mjs';
import {STRIPE_ACCOUNTS,StripeProjectionError} from './stripe-financial-projection.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=()=>{throw new StripeProjectionError('aaro_checkout_unavailable');};
export function createAaroCheckout({enabled=false,mode='live',stripe,rpc,clock=Date.now}={}){
 if(!enabled)return Object.freeze({checkout:async()=>fail(),portal:async()=>fail()});
 if(!STRIPE_ACCOUNTS[mode]||typeof rpc!=='function'||!stripe?.customers?.create||!stripe?.accounts?.retrieve)fail();
 const identity=async signal=>{signal?.throwIfAborted();if((await stripe.accounts.retrieve()).id!==STRIPE_ACCOUNTS[mode])fail();signal?.throwIfAborted();};
 const customer=async(owner,signal)=>{
  let value=await rpc('aaro_billing_customer_v1',{p_owner:owner,p_customer:null},{signal});signal?.throwIfAborted();
  if(value.owner!==owner)fail();
  if(!value.customerId){
   const created=await stripe.customers.create({metadata:{aaro_owner:owner}},{idempotencyKey:'aaro-owner-'+createHash('sha256').update(owner).digest('hex'),maxNetworkRetries:0,timeout:12000});
   if(!/^cus_[A-Za-z0-9]+$/.test(created?.id)||created.livemode!==(mode==='live')||created.metadata?.aaro_owner!==owner)fail();
   signal?.throwIfAborted();value=await rpc('aaro_billing_customer_v1',{p_owner:owner,p_customer:created.id},{signal});
   if(value.owner!==owner||value.customerId!==created.id)fail();
  }
  const native=await stripe.customers.retrieve(value.customerId);
  if(native.id!==value.customerId||native.deleted||native.livemode!==(mode==='live')||native.metadata?.aaro_owner!==owner)fail();
  signal?.throwIfAborted();return value.customerId;
 };
 const ownerCheck=owner=>{if(typeof owner!=='string'||!owner.startsWith(mode+':supabase:')||!UUID.test(owner.split(':')[2]??''))fail();};
 return Object.freeze({async checkout(owner,input,{signal}={}){
  strictObject(input,['plan','returnTo']);ownerCheck(owner);
  const plan=catalog.plans.find(x=>x.id===input.plan);if(!plan||input.returnTo!=='aaro')fail();
  try{
   await identity(signal);const price=await stripe.prices.retrieve(plan.priceId),product=await stripe.products.retrieve(plan.productId);signal?.throwIfAborted();
   if(price.id!==plan.priceId||price.active!==true||price.livemode!==(mode==='live')||price.unit_amount!==plan.amount||price.currency!==plan.currency||price.type!=='recurring'
    ||price.recurring?.interval!=='month'||price.recurring.interval_count!==1||(typeof price.product==='string'?price.product:price.product?.id)!==plan.productId
    ||product.id!==plan.productId||product.livemode!==(mode==='live')||product.active!==true||product.metadata?.brand!=='aaro'||product.metadata.plan!==plan.id||product.metadata.credits!==String(plan.credits))fail();
   const customerId=await customer(owner,signal),b=await rpc('aaro_checkout_prepare_v1',{p_owner:owner,p_id:randomUUID(),p_plan_reference:plan.id},{signal});signal?.throwIfAborted();
   const created=Date.parse(b?.created_at),expires=Date.parse(b?.expires_at);
   if(!UUID.test(b?.id??'')||b.owner!==owner||b.customer_id!==customerId||b.plan_reference!==plan.id||b.plan?.priceId!==plan.priceId||b.plan?.credits!==plan.credits
    ||!Number.isFinite(created)||!Number.isFinite(expires)||expires-created>3600000||expires<=created||clock()<created-30000||expires<clock()+31*60000||b.subscription_id!==null)fail();
   // An ambiguous creation retries the SAME frozen order inside a <1h window,
   // never a new order after Stripe's idempotency retention window.
   const metadata={aaro_checkout:b.id,brand:'aaro',plan:plan.id};
   const args={mode:'subscription',customer:customerId,client_reference_id:b.id,metadata,subscription_data:{metadata},line_items:[{price:plan.priceId,quantity:1}],adaptive_pricing:{enabled:false},
    success_url:'https://aaroglobal.com/account?billing=return',cancel_url:'https://aaroglobal.com/account?billing=cancelled',expires_at:Math.floor(expires/1000)};
   const s=b.session_id?await stripe.checkout.sessions.retrieve(b.session_id):await stripe.checkout.sessions.create(args,{idempotencyKey:'aaro-checkout-'+b.id,maxNetworkRetries:0,timeout:12000});
   if(!new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$').test(s?.id)||s.livemode!==(mode==='live')||s.mode!=='subscription'||s.customer!==customerId||s.client_reference_id!==b.id
    ||s.metadata?.aaro_checkout!==b.id||s.currency!==plan.currency||s.amount_subtotal!==plan.amount||s.status!=='open'||s.expires_at!==args.expires_at)fail();
   const url=new URL(s.url);if(url.origin!=='https://checkout.stripe.com'||url.username||url.password||!url.pathname.startsWith('/c/'))fail();
   signal?.throwIfAborted();const stored=await rpc('aaro_checkout_record_v1',{p_owner:owner,p_id:b.id,p_session:s.id},{signal});if(stored.id!==b.id||stored.session_id!==s.id||stored.owner!==owner)fail();
   return Object.freeze({url:url.href,orderId:b.id,creditsGranted:false});
  }catch{fail();}
 },async portal(owner,input,{signal}={}){
  strictObject(input,['returnTo']);ownerCheck(owner);if(input.returnTo!=='aaro')fail();
  try{await identity(signal);const value=await rpc('aaro_billing_customer_v1',{p_owner:owner,p_customer:null},{signal});signal?.throwIfAborted();if(value.owner!==owner||!value.customerId)fail();
   const native=await stripe.customers.retrieve(value.customerId);if(native.id!==value.customerId||native.livemode!==(mode==='live')||native.deleted||native.metadata?.aaro_owner!==owner)fail();
   signal?.throwIfAborted();const session=await stripe.billingPortal.sessions.create({customer:value.customerId,return_url:'https://aaroglobal.com/account'},{maxNetworkRetries:0,timeout:12000});
   const url=new URL(session.url);if(url.origin!=='https://billing.stripe.com'||url.username||url.password||!url.pathname.startsWith('/p/'))fail();return {url:url.href};
  }catch{fail();}
 }});
}
