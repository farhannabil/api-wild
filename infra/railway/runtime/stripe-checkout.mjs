// Server only. Caller authenticates owner through Supabase; no browser identity.
// Uses the existing stripe_orders -> stripe_project -> gateway_accounts ledger.
import {createHash} from 'node:crypto';
import {strictObject} from './supabase-gateway-rpc.mjs';
import {STRIPE_ACCOUNTS,StripeProjectionError} from './stripe-financial-projection.mjs';
import {CREDIT_PACKS,CREDIT_PROMOTION_ID,isCreditOfferPolicy} from './credit-offers.mjs';
import {isTemporaryCreditOfferPolicy} from './temporary-credit-offer.mjs';
export const CHECKOUT_REGISTER_RPC='apiwild_stripe_register_checkout';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=(code,status=503)=>{throw new StripeProjectionError(code,status)};
export function createOwnStripeCheckout(config={}){
 strictObject(config,['enabled','billingMode','accountId','priceId','stripeClient','resolveCustomer','register','creditOffers','temporaryOffer']);
 if(config.enabled!==true)return Object.freeze({async checkout(){fail('checkout_disabled')}});
 const {billingMode:mode,accountId:account,priceId,stripeClient:stripe,resolveCustomer,register}=config;
 if(!['live','test'].includes(mode)||account!==STRIPE_ACCOUNTS[mode]||!/^price_[A-Za-z0-9]+$/.test(priceId)||typeof resolveCustomer!=='function'||typeof register!=='function'||!stripe?.checkout?.sessions?.create||!stripe?.prices?.retrieve||!stripe?.accounts?.retrieve)fail('checkout_invalid_configuration');
 if(config.creditOffers!==undefined&&!isCreditOfferPolicy(config.creditOffers))fail('checkout_invalid_configuration');
 if(config.temporaryOffer!==undefined&&!isTemporaryCreditOfferPolicy(config.temporaryOffer))fail('checkout_invalid_configuration');
 return Object.freeze({async checkout(owner,input){
  strictObject(input,['amountCents','packageId','requestId']);
  const temporaryPack=input.packageId==='launch-dollar'?config.temporaryOffer?.read(owner):null;
  const pack=Object.hasOwn(input,'packageId')?temporaryPack||CREDIT_PACKS.find(pack=>pack.id===input.packageId):null;
  if(typeof owner!=='string'||!owner.startsWith(mode+':supabase:')||!UUID.test(owner.slice((mode+':supabase:').length))||!UUID.test(input.requestId)||Object.hasOwn(input,'packageId')===Object.hasOwn(input,'amountCents')||(Object.hasOwn(input,'packageId')&&(!pack||(!config.creditOffers&&!temporaryPack)))||(!pack&&(!Number.isSafeInteger(input.amountCents)||input.amountCents<3000||input.amountCents>100000000||input.amountCents%100!==0)))fail('checkout_invalid_request',400);
  // One-dollar unit Price supports whole dollar purchases, not rounded cents.
  const amount=pack?pack.priceCents:input.amountCents,selectedPrice=temporaryPack?config.temporaryOffer.priceId:pack?config.creditOffers.prices[pack.id]:priceId,hex=createHash('sha256').update(account+'\n'+owner+'\n'+input.requestId).digest('hex');
  const orderId=hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);
  try{
   const identity=await stripe.accounts.retrieve();if(identity.id!==account)fail('checkout_account_mismatch');
   const price=await stripe.prices.retrieve(selectedPrice);
   if(price.id!==selectedPrice||price.active!==true||price.livemode!==(mode==='live')||price.currency!=='usd'||price.type!=='one_time'||price.unit_amount!==(pack?amount:100)||price.recurring)fail('checkout_price_mismatch');
   const customer=await resolveCustomer(owner);if(typeof customer!=='string'||!/^cus_[A-Za-z0-9]+$/.test(customer))fail('checkout_customer_unavailable');
   const metadata={order_id:orderId,funding_mode:'one_time'};
   let intent;
   if(config.creditOffers||temporaryPack){
    intent=await register('apiwild_stripe_prepare_checkout',{p_order_id:orderId,p_user_id:owner,p_billing_mode:mode,p_account_id:account,p_price_id:selectedPrice,p_package_id:pack?.id??null,p_amount_cents:amount,p_promo_starts_at:temporaryPack?null:config.creditOffers.startsAt,p_promo_ends_at:temporaryPack?null:config.creditOffers.endsAt});
    const created=Date.parse(intent?.created_at),expires=Date.parse(intent?.expires_at);
    if(intent?.prepared!==true||intent.order_id!==orderId||intent.user_id!==owner||intent.billing_mode!==mode||intent.account_id!==account||intent.price_id!==selectedPrice||intent.amount_cents!==amount||intent.package_id!==(pack?.id??null)||!Number.isSafeInteger(intent.bonus_cents)||!([0,pack?.bonusCents??0].includes(intent.bonus_cents))||intent.credit_cents!==amount+intent.bonus_cents||(intent.bonus_cents>0?intent.promotion_id!==CREDIT_PROMOTION_ID:intent.promotion_id!==null)||!Number.isFinite(created)||!Number.isFinite(expires)||expires<=created||expires-created>3600000||(intent.session_id!==null&&!new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$').test(intent.session_id)))fail('checkout_registration_unavailable');
    if(intent.bonus_cents>0&&(Date.parse(intent.promo_ends_at)-Date.parse(intent.promo_starts_at)!==(15*86400000+31*60000)||created<Date.parse(intent.promo_starts_at)||created>=Date.parse(intent.promo_ends_at)-31*60000||expires>Date.parse(intent.promo_ends_at)))fail('checkout_registration_unavailable');
    if(temporaryPack&&(!config.temporaryOffer.hasCheckoutWindow(intent.expires_at)||created>=Date.parse(temporaryPack.endsAt)-31*60000||intent.promo_starts_at!==null||intent.promo_ends_at!==null||intent.legacy_order===true))fail('checkout_registration_unavailable');
   }
   const parameters={mode:'payment',adaptive_pricing:{enabled:false},branding_settings:{display_name:'API WILD'},customer,client_reference_id:orderId,metadata,payment_intent_data:{metadata},line_items:[{price:selectedPrice,quantity:pack?1:amount/100}],success_url:'https://apiwild.com/console/billing?payment=return',cancel_url:'https://apiwild.com/console/billing?payment=cancelled',integration_identifier:'apiwild_'+hex.slice(0,8).replace(/[0-9]/g,n=>String.fromCharCode(97+Number(n))),...(intent?{expires_at:Math.floor(Date.parse(intent.expires_at)/1000)}:{})};
   const s=intent?.session_id?await stripe.checkout.sessions.retrieve(intent.session_id):await stripe.checkout.sessions.create(parameters,{idempotencyKey:'apiwild-checkout-'+orderId,maxNetworkRetries:0,timeout:15000});
   if(!s||!new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$').test(s.id)||s.mode!=='payment'||s.livemode!==(mode==='live')||s.customer!==customer||s.client_reference_id!==orderId||s.metadata?.order_id!==orderId||s.metadata?.funding_mode!=='one_time'||s.currency!=='usd'||s.amount_subtotal!==amount||s.amount_total!==amount||s.status!=='open'||s.payment_status!=='unpaid'||s.total_details?.amount_discount!==0||s.total_details?.amount_tax!==0)fail('checkout_session_mismatch');
   if(intent?.legacy_order===true&&(intent.bonus_cents!==0||intent.package_id!==null||!intent.session_id))fail('checkout_session_mismatch');
   if(intent&&intent.legacy_order!==true&&s.expires_at!==parameters.expires_at)fail('checkout_session_mismatch');
   const url=new URL(s.url);if(url.origin!=='https://checkout.stripe.com'||url.username||url.password||!url.pathname.startsWith('/c/'))fail('checkout_session_mismatch');
   const result=await register(CHECKOUT_REGISTER_RPC,{p_order_id:orderId,p_user_id:owner,p_billing_mode:mode,p_account_id:account,p_session_id:s.id,p_customer_id:customer,p_amount_cents:amount});
   if(result?.registered!==true||result.order_id!==orderId||result.session_id!==s.id)fail('checkout_registration_unavailable');
   return Object.freeze({url:url.href,orderId,creditsGranted:false,...(intent?{packageId:intent.package_id,paidCents:amount,bonusCents:intent.bonus_cents,totalCreditCents:intent.credit_cents,promotionId:intent.promotion_id}:{})});
  }catch(error){const safe=error instanceof StripeProjectionError?error:new StripeProjectionError('checkout_unavailable',503);safe.orderId=orderId;throw safe;}
 }});
}
