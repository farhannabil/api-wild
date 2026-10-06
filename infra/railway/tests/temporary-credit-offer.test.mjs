import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {createTemporaryCreditOfferFromEnv} from '../runtime/temporary-credit-offer.mjs';
import {createOwnStripeCheckout} from '../runtime/stripe-checkout.mjs';
import {createOwnedBillingFromEnv} from '../runtime/owned-billing.mjs';
const now=Date.parse('2026-10-06T00:30:00.000Z'),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='test:supabase:'+id,account='acct_1UCiHk0SGcPsf6AA';
const requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',input={packageId:'launch-dollar',requestId};
const env={OWN_BILLING_ENABLED:'true',APIWILD_CHECKOUT_ENABLED:'true',BILLING_MODE:'test',SUPABASE_SECRET_KEY:'sb_secret_syntheticFixtureOnly000000',STRIPE_SECRET_KEY:'rk_test_syntheticFixtureOnly000000',STRIPE_WEBHOOK_SECRET:'whsec_syntheticFixtureOnly000000',STRIPE_CREDIT_PRICE_ID:'price_standard',APIWILD_TEMP_CREDIT_PRICE_ID:'price_dollar',APIWILD_TEMP_CREDIT_OWNER_ID:owner,APIWILD_TEMP_CREDIT_END_AT:new Date(now+12*3600000).toISOString(),APIWILD_PACK_PRICES_JSON:JSON.stringify({smart:'price_smart',nerd:'price_nerd',newton:'price_newton',alien:'price_alien'})};
function fixture({intentPatch={},pricePatch={},dbEligible=true,authenticatedId=id}={}){
 const calls=[],stripeCalls=[];let intent,session;
 const register=async(name,p)=>{calls.push({name,p});if(name==='apiwild_stripe_prepare_checkout'){
  if(intent&&intent.order_id!==p.p_order_id)throw Error('temporary_offer_already_used');
  intent??={prepared:true,order_id:p.p_order_id,user_id:p.p_user_id,billing_mode:p.p_billing_mode,account_id:p.p_account_id,price_id:p.p_price_id,package_id:p.p_package_id,amount_cents:100,bonus_cents:0,credit_cents:100,promotion_id:null,promo_starts_at:null,promo_ends_at:null,created_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString(),session_id:null,legacy_order:false};
  return {...intent,session_id:session?.id??null,...intentPatch};
 }return {registered:true,order_id:p.p_order_id,session_id:p.p_session_id};};
 const stripe={accounts:{retrieve:async()=>{stripeCalls.push('account');return {id:account};}},prices:{retrieve:async priceId=>{stripeCalls.push('price');return {id:priceId,active:true,livemode:false,currency:'usd',type:'one_time',unit_amount:100,...pricePatch};}},checkout:{sessions:{create:async(p,o)=>{stripeCalls.push({p,o});session={id:'cs_test_dollar',mode:'payment',livemode:false,customer:p.customer,client_reference_id:p.client_reference_id,metadata:p.metadata,currency:'usd',amount_subtotal:100,amount_total:100,status:'open',payment_status:'unpaid',total_details:{amount_discount:0,amount_tax:0},expires_at:p.expires_at,url:'https://checkout.stripe.com/c/pay/dollar'};return session;},retrieve:async sessionId=>{stripeCalls.push('retrieve');assert.equal(sessionId,session.id);return session;}}}};
 const policy=createTemporaryCreditOfferFromEnv(env,{clock:()=>now});
 const checkout=createOwnStripeCheckout({enabled:true,billingMode:'test',accountId:account,priceId:'price_standard',stripeClient:stripe,resolveCustomer:async()=> 'cus_fixture',register,temporaryOffer:policy});
 const fetchImpl=async(url,options)=>{
  const name=url.split('/').at(-1),p=options?.body?JSON.parse(options.body):undefined;
  if(name==='user')return Response.json({id:authenticatedId,email_confirmed_at:'confirmed'});
  if(name==='apiwild_gateway_account_initialize')return Response.json({initialized:true,customer_id:authenticatedId,billing_mode:'test'});
  if(name==='apiwild_billing_read')return Response.json({balanceCents:0,orders:[],suspended:false});
  if(name==='apiwild_temporary_credit_offer_read')return Response.json({eligible:dbEligible,user_id:owner,price_id:'price_dollar',ends_at:env.APIWILD_TEMP_CREDIT_END_AT,order_id:null});
  if(name==='apiwild_stripe_customer')return Response.json({customerId:'cus_fixture'});
  return Response.json(await register(name,p));
 };
 return {calls,stripeCalls,checkout,billing:()=>createOwnedBillingFromEnv(env,{clock:()=>now,fetchImpl,stripeClient:stripe})};
}
async function run(port,path,method='GET',body){const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url:path,method,headers:{authorization:'Bearer '+'x'.repeat(30),origin:'https://apiwild.com','content-type':'application/json'}});let result;await port.handle(req,{writeHead(status){this.status=status;},end(text){result={status:this.status,data:JSON.parse(text)};}});return result;}

test('temporary offer is disabled by default, owner-bound, canonical, at most24hours and31minute bounded',()=>{
 assert.equal(createTemporaryCreditOfferFromEnv(),undefined);
 for(const patch of [{APIWILD_TEMP_CREDIT_OWNER_ID:''},{APIWILD_TEMP_CREDIT_PRICE_ID:'bad'},{APIWILD_TEMP_CREDIT_END_AT:new Date(now+86400001).toISOString()}])assert.throws(()=>createTemporaryCreditOfferFromEnv({...env,...patch},{clock:()=>now}));
 let clock=now;const policy=createTemporaryCreditOfferFromEnv({...env,APIWILD_TEMP_CREDIT_END_AT:'2026-10-06T12:30:00Z'},{clock:()=>clock});
 assert.equal(policy.read(owner.replace('aaaa','bbbb')),null);assert.equal(policy.read(owner).endsAt,'2026-10-06T12:30:00.000Z');
 clock=Date.parse(policy.endsAt)-31*60000;assert.ok(policy.read(owner));clock++;assert.equal(policy.read(owner),null);
 assert.throws(()=>createOwnStripeCheckout({enabled:true,billingMode:'test',accountId:account,priceId:'price_standard',stripeClient:{checkout:{sessions:{create(){}}},prices:{retrieve(){}},accounts:{retrieve(){}}},register(){},resolveCustomer(){},temporaryOffer:{read(){}}}));
});
test('only the eligible authenticated owner sees the offer; public four packs remain unchanged',async()=>{
 const f=fixture(),port=await f.billing(),data=(await run(port,'/api/billing')).data;
 assert.deepEqual(data.temporaryOffer,{id:'launch-dollar',name:'API WILD $1 credits',priceCents:100,bonusCents:0,totalCreditCents:100,endsAt:env.APIWILD_TEMP_CREDIT_END_AT,orderId:null});assert.equal(data.minimumTopupCents,3000);
 const publicOffers=(await run(port,'/api/billing/offers')).data;assert.ok(!JSON.stringify(publicOffers).includes('launch-dollar'));assert.equal(publicOffers.packages.length,4);
 for(const options of [{dbEligible:false},{authenticatedId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}])assert.equal((await run(await fixture(options).billing(),'/api/billing')).data.temporaryOffer,undefined);
});
test('launch-dollar creates one exact100cent unit with normal registration and no granted credit',async()=>{
 const f=fixture(),result=await f.checkout.checkout(owner,input);assert.equal(result.paidCents,100);assert.equal(result.totalCreditCents,100);assert.equal(result.bonusCents,0);assert.equal(result.creditsGranted,false);
 const create=f.stripeCalls.find(call=>typeof call==='object');assert.deepEqual(create.p.line_items,[{price:'price_dollar',quantity:1}]);assert.equal(create.o.maxNetworkRetries,0);
 assert.deepEqual(f.calls.map(call=>call.name),['apiwild_stripe_prepare_checkout','apiwild_stripe_register_checkout']);
 assert.equal(f.calls[0].p.p_promo_starts_at,null);assert.equal(f.calls[0].p.p_promo_ends_at,null);
 await f.checkout.checkout(owner,input);assert.equal(f.stripeCalls.filter(call=>typeof call==='object').length,1);assert.ok(f.stripeCalls.includes('retrieve'));
 await assert.rejects(f.checkout.checkout(owner,{...input,requestId:requestId.replace('bbbb','cccc')}));assert.equal(f.stripeCalls.filter(call=>typeof call==='object').length,1);
});
test('wrong owners, raw100cent topups and unsupported packages cannot reach Stripe',async()=>{
 for(const [who,data]of [[owner.replace('aaaa','cccc'),input],[owner,{amountCents:100,requestId}],[owner,{...input,amountCents:100}],[owner,{...input,packageId:'other'}]]){const f=fixture();await assert.rejects(f.checkout.checkout(who,data));assert.equal(f.stripeCalls.length,0);}
});
test('wrong native prices, bonus intents and insufficient checkout time never create a session',async()=>{
 for(const options of [{pricePatch:{unit_amount:200}},{intentPatch:{bonus_cents:100,credit_cents:200}},{intentPatch:{promotion_id:'fake'}},{intentPatch:{expires_at:new Date(now+30*60000).toISOString()}},{intentPatch:{promo_ends_at:env.APIWILD_TEMP_CREDIT_END_AT}}]){const f=fixture(options);await assert.rejects(f.checkout.checkout(owner,input));assert.equal(f.stripeCalls.filter(call=>typeof call==='object').length,0);}
});
