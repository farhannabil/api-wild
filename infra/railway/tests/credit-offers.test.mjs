import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {CREDIT_PACKS,createCreditOfferPolicy} from '../runtime/credit-offers.mjs';
import {createOwnStripeCheckout} from '../runtime/stripe-checkout.mjs';
import {createOwnedBillingFromEnv} from '../runtime/owned-billing.mjs';
const prices=Object.fromEntries(CREDIT_PACKS.map(p=>[p.id,'price_'+p.id]));
const startsAt='2026-10-05T00:00:00.000Z',endsAt='2026-10-20T00:31:00.000Z',owner='test:supabase:12345678-1234-4123-8123-123456789abc',requestId='12345678-1234-4123-8123-123456789abc';
const policy=clock=>createCreditOfferPolicy({prices,startsAt,endsAt,clock});
test('fixed 15 day opening window, 31 minute grace, exact grants, restart and boundaries',()=>{
 for(const [now,active] of [[Date.parse(startsAt)-1,false],[Date.parse(startsAt),true],[Date.parse(endsAt)-31*60000-1,true],[Date.parse(endsAt)-31*60000,false],[Date.parse(endsAt),false]]){
  const read=policy(()=>now).read();assert.equal(read.promotion.active,active);assert.equal(Date.parse(read.promotion.checkoutClosesAt)-Date.parse(startsAt),15*86400000);assert.deepEqual(read.packages.map(p=>[p.priceCents,p.bonusCents,p.totalCreditCents]),[[7700,active?1300:0,active?9000:7700],[10100,active?1900:0,active?12000:10100],[23400,active?2600:0,active?26000:23400],[34500,active?5500:0,active?40000:34500]]);assert.deepEqual(policy(()=>now).read(),read);assert.ok(!JSON.stringify(read).includes('price_smart'));
 }
});
test('rejects rolling, invalid date and incomplete or foreign price configuration',()=>{
 for(const opts of [{prices:{...prices,other:'price_x'}},{prices:{...prices,smart:'evil'}},{prices,startsAt},{prices,startsAt,endsAt:'2026-10-20T00:00:00Z'},{prices,startsAt:'2026-02-30T00:00:00Z',endsAt}])assert.throws(()=>createCreditOfferPolicy(opts));
 assert.equal(createCreditOfferPolicy({prices}).read().packages[0].bonusCents,0);
});
function fixture({bonus=1300,intentPatch={},sessionPatch={},replay=false}={}){
 const calls=[];let saved;const stripe={accounts:{retrieve:async()=>({id:'acct_1UCiHk0SGcPsf6AA'})},prices:{retrieve:async id=>({id,active:true,livemode:false,currency:'usd',type:'one_time',unit_amount:id==='price_custom'?100:7700})},checkout:{sessions:{create:async(p)=>{calls.push(['create',p]);saved={id:'cs_test_example',mode:'payment',livemode:false,customer:p.customer,client_reference_id:p.client_reference_id,metadata:p.metadata,currency:'usd',amount_subtotal:p.line_items[0].price==='price_custom'?3000:7700,amount_total:p.line_items[0].price==='price_custom'?3000:7700,status:'open',payment_status:'unpaid',expires_at:p.expires_at,total_details:{amount_discount:0,amount_tax:0},url:'https://checkout.stripe.com/c/pay/example',...sessionPatch};return saved},retrieve:async()=>{calls.push(['retrieve']);return saved}}}};
 const register=async(n,p)=>{calls.push([n,p]);if(n==='apiwild_stripe_prepare_checkout'){const grant=p.p_package_id?bonus:0;return {prepared:true,order_id:p.p_order_id,user_id:p.p_user_id,billing_mode:p.p_billing_mode,account_id:p.p_account_id,price_id:p.p_price_id,package_id:p.p_package_id,amount_cents:p.p_amount_cents,bonus_cents:grant,credit_cents:p.p_amount_cents+grant,promotion_id:grant?'apiwild-credit-packs-v1':null,promo_starts_at:grant?startsAt:null,promo_ends_at:grant?endsAt:null,created_at:'2026-10-05T01:00:00Z',expires_at:'2026-10-05T02:00:00Z',session_id:replay&&saved?saved.id:null,...intentPatch}}return {registered:true,order_id:p.p_order_id,session_id:p.p_session_id}};
 return {calls,session:()=>saved,port:createOwnStripeCheckout({enabled:true,billingMode:'test',accountId:'acct_1UCiHk0SGcPsf6AA',priceId:'price_custom',stripeClient:stripe,resolveCustomer:async()=> 'cus_example',register,creditOffers:policy(()=>Date.parse(startsAt))})};
}
test('pack terms come from server and frozen SQL intent, not client metadata',async()=>{
 const f=fixture();const r=await f.port.checkout(owner,{packageId:'smart',requestId});assert.equal(r.totalCreditCents,9000);assert.equal(r.creditsGranted,false);const p=f.calls.find(x=>x[0]==='create')[1];assert.deepEqual(p.line_items,[{price:'price_smart',quantity:1}]);assert.equal(p.payment_method_types,undefined);assert.equal(p.expires_at,Date.parse('2026-10-05T02:00:00Z')/1000);assert.deepEqual(Object.keys(p.metadata).sort(),['funding_mode','order_id']);assert.equal(f.calls.at(-1)[0],'apiwild_stripe_register_checkout');
});
test('custom amount and inactive package remain base purchases without bonus',async()=>{
 for(const input of [{amountCents:3000,requestId},{packageId:'smart',requestId}]){const f=fixture({bonus:0});const r=await f.port.checkout(owner,input);assert.equal(r.bonusCents,0);assert.equal(r.totalCreditCents,r.paidCents);assert.equal(r.promotionId,null)}
});
test('mixed requests, invented pack and client bonus fail before Stripe creation',async()=>{
 for(const input of [{packageId:'smart',amountCents:7700,requestId},{packageId:'unknown',requestId},{packageId:'smart',bonusCents:999999,requestId}]){const f=fixture();await assert.rejects(f.port.checkout(owner,input));assert.equal(f.calls.length,0)}
});
test('tampered intent ownership, grant, dates, expiry and session fail closed',async()=>{
 for(const intentPatch of [{user_id:'other'},{billing_mode:'live'},{account_id:'wrong'},{price_id:'price_wrong'},{bonus_cents:5500,credit_cents:13200},{promo_starts_at:'2026-10-06T00:00:00Z'},{expires_at:'2026-10-05T03:00:00Z'},{session_id:'cs_live_other'}]){const f=fixture({intentPatch});await assert.rejects(f.port.checkout(owner,{packageId:'smart',requestId}),{code:'checkout_registration_unavailable'});assert.ok(!f.calls.some(x=>x[0]==='create'))}
});
test('registered same request retrieves existing session and expiry instead of new checkout',async()=>{
 const f=fixture({replay:true});const a=await f.port.checkout(owner,{packageId:'smart',requestId}),b=await f.port.checkout(owner,{packageId:'smart',requestId});assert.deepEqual(a,b);assert.equal(f.calls.filter(x=>x[0]==='create').length,1);assert.equal(f.calls.filter(x=>x[0]==='retrieve').length,1);
});
test('paid or expired existing sessions never create a replacement checkout',async()=>{
 for(const patch of [{status:'complete',payment_status:'paid'},{status:'expired'}]){const f=fixture({replay:true});await f.port.checkout(owner,{packageId:'smart',requestId});Object.assign(f.session(),patch);await assert.rejects(f.port.checkout(owner,{packageId:'smart',requestId}),{code:'checkout_session_mismatch'});assert.equal(f.calls.filter(x=>x[0]==='create').length,1)}
});
test('legacy expiry exception accepts only zero-bonus existing custom sessions',async()=>{
 const patch={};const f=fixture({replay:true,intentPatch:patch});await f.port.checkout(owner,{amountCents:3000,requestId});patch.legacy_order=true;f.session().expires_at+=7200;assert.equal((await f.port.checkout(owner,{amountCents:3000,requestId})).bonusCents,0);assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
 const invalid={};const p=fixture({replay:true,intentPatch:invalid});await p.port.checkout(owner,{packageId:'smart',requestId});invalid.legacy_order=true;await assert.rejects(p.port.checkout(owner,{packageId:'smart',requestId}),{code:'checkout_session_mismatch'});assert.equal(p.calls.filter(x=>x[0]==='create').length,1);
});
test('session expiry cannot extend trusted intent',async()=>{const f=fixture({sessionPatch:{expires_at:1}});await assert.rejects(f.port.checkout(owner,{packageId:'smart',requestId}),{code:'checkout_session_mismatch'});assert.ok(!f.calls.some(x=>x[0]==='apiwild_stripe_register_checkout'))});
test('validated request failures retain safe order ID without granting or creating a replacement',async()=>{const f=fixture({intentPatch:{bonus_cents:999999}});let first;for(let i=0;i<2;i++)await assert.rejects(f.port.checkout(owner,{packageId:'smart',requestId}),e=>{assert.match(e.orderId,/^[a-f0-9-]{36}$/);if(first)assert.equal(e.orderId,first);first=e.orderId;return true});assert.ok(!f.calls.some(x=>x[0]==='create'))});
test('public offers require no authentication or external call and never expose price IDs',async()=>{
 const port=await createOwnedBillingFromEnv({OWN_BILLING_ENABLED:'true',APIWILD_PACK_PRICES_JSON:JSON.stringify(prices),APIWILD_CREDIT_PROMO_START_AT:startsAt,APIWILD_CREDIT_PROMO_END_AT:endsAt},{fetchImpl:async()=>{throw Error('unexpected remote call')},clock:()=>Date.parse(startsAt)});
 const run=async(method='GET',headers={},url='/api/billing/offers')=>{const req=Readable.from([]);Object.assign(req,{method,url,headers});let out;await port.handle(req,{writeHead(status){this.status=status},end(body){out={status:this.status,body:JSON.parse(body)}}});return out};
 const result=await run();assert.equal(result.status,200);assert.equal(result.body.packages[0].totalCreditCents,9000);assert.ok(!JSON.stringify(result.body).includes('price_smart'));assert.equal((await run('POST')).status,405);assert.equal((await run('GET',{'oai-authenticated-user-id':'forged'})).status,403);assert.equal((await run('GET',{},'/api/billing/offers?bonus=1')).status,503);
});
