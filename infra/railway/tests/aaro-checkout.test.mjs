import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../../../lib/aaro-plans.json' with {type:'json'};
import {createAaroCheckout} from '../runtime/aaro-checkout.mjs';
import {STRIPE_ACCOUNTS} from '../runtime/stripe-financial-projection.mjs';
const owner='live:supabase:12345678-1234-4123-8123-123456789abc',order='22345678-1234-4123-8123-123456789abc',now=2000000000000,plan=catalog.plans.find(x=>x.id==='global-starter');
function fixture(){
 const creates=[],writes=[],state={binding:{id:order,owner,customer_id:'cus_Fixture',plan_reference:plan.id,plan:structuredClone(plan),created_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString(),subscription_id:null,session_id:null},account:STRIPE_ACCOUNTS.live};
 const customer={id:'cus_Fixture',livemode:true,metadata:{aaro_owner:owner}},price={id:plan.priceId,active:true,livemode:true,unit_amount:plan.amount,currency:plan.currency,type:'recurring',product:plan.productId,recurring:{interval:'month',interval_count:1}},product={id:plan.productId,active:true,livemode:true,metadata:{brand:'aaro',plan:plan.id,credits:String(plan.credits)}};
 const session={id:'cs_live_Fixture',livemode:true,mode:'subscription',customer:'cus_Fixture',client_reference_id:order,metadata:{aaro_checkout:order},currency:'usd',amount_subtotal:1500,status:'open',expires_at:(now+3600000)/1000,url:'https://checkout.stripe.com/c/Fixture'};
 const stripe={accounts:{retrieve:async()=>({id:state.account})},prices:{retrieve:async()=>price},products:{retrieve:async()=>product},customers:{retrieve:async()=>customer,create:async(p,o)=>{creates.push({type:'customer',p,o});return customer;}},checkout:{sessions:{create:async(p,o)=>{creates.push({type:'checkout',p,o});return session;},retrieve:async()=>session}},billingPortal:{sessions:{create:async(p,o)=>{creates.push({type:'portal',p,o});return {url:'https://billing.stripe.com/p/Fixture'};}}}};
 const rpc=async(name,p)=>{writes.push({name,p});if(name==='aaro_billing_customer_v1')return {owner,customerId:customer.id};if(name==='aaro_checkout_prepare_v1')return state.binding;if(name==='aaro_checkout_record_v1')return {...state.binding,session_id:p.p_session};throw Error('Unexpected RPC');};
 return {client:createAaroCheckout({enabled:true,mode:'live',stripe,rpc,clock:()=>now}),creates,writes,state,price,product,customer,session};
}
await test('disabled checkout and arbitrary caller funding inputs cannot create payments',async()=>{
 await assert.rejects(createAaroCheckout().checkout(owner,{plan:plan.id,returnTo:'aaro'}));
 for(const input of [{plan:plan.id,returnTo:'apiwild'},{plan:'unknown',returnTo:'aaro'},{plan:plan.id,returnTo:'aaro',amount:1}]){const f=fixture();await assert.rejects(f.client.checkout(owner,input));assert.equal(f.creates.length,0);}
});
await test('original canonical monthly plan and frozen order precede idempotent Checkout; returns remain on AARO',async()=>{
 const f=fixture();const result=await f.client.checkout(owner,{plan:plan.id,returnTo:'aaro'});assert.equal(result.creditsGranted,false);assert.equal(result.orderId,order);
 assert.equal(f.creates.length,1);const {p,o}=f.creates[0];assert.equal(o.idempotencyKey,'aaro-checkout-'+order);assert.equal(o.maxNetworkRetries,0);assert.equal(p.success_url,'https://aaroglobal.com/account?billing=return');assert.deepEqual(p.line_items,[{price:plan.priceId,quantity:1}]);assert.equal(p.subscription_data.metadata.aaro_checkout,order);assert.equal(p.automatic_tax,undefined);assert.equal(p.payment_method_types,undefined);
 assert(f.writes.every(x=>x.name.startsWith('aaro_')));
});
await test('recorded open session is retrieved without another creation',async()=>{const f=fixture();f.state.binding.session_id='cs_live_Fixture';await f.client.checkout(owner,{plan:plan.id,returnTo:'aaro'});assert.equal(f.creates.length,0);});
await test('stale, malformed or foreign order and accepted subscription never create a replacement',async()=>{
 for(const patch of [{expires_at:new Date(now+1000).toISOString()},{created_at:new Date(now+60000).toISOString()},{owner:owner.replace('12345678','33333333')},{subscription_id:'sub_Fixture'},{customer_id:'cus_other'}]){const f=fixture();Object.assign(f.state.binding,patch);await assert.rejects(f.client.checkout(owner,{plan:plan.id,returnTo:'aaro'}));assert.equal(f.creates.length,0);}
});
await test('wrong account, price, merchant product or owner denies before payment creation',async()=>{
 for(const [kind,patch] of [['price',{unit_amount:1}],['product',{metadata:{brand:'apiwild'}}],['customer',{metadata:{aaro_owner:'attacker'}}]]){const f=fixture();Object.assign(f[kind],patch);await assert.rejects(f.client.checkout(owner,{plan:plan.id,returnTo:'aaro'}));assert.equal(f.creates.length,0);}
 const f=fixture();f.state.account='acct_other';await assert.rejects(f.client.checkout(owner,{plan:plan.id,returnTo:'aaro'}));assert.equal(f.writes.length,0);
});
await test('canonical session mismatch or off-domain URL is not returned; no grant fallback',async()=>{
 for(const patch of [{currency:'bdt'},{client_reference_id:'wrong'},{mode:'payment'},{url:'https://evil.example/c/Fixture'},{expires_at:1}]){const f=fixture();Object.assign(f.session,patch);await assert.rejects(f.client.checkout(owner,{plan:plan.id,returnTo:'aaro'}));assert(!f.writes.some(x=>x.name==='aaro_checkout_record_v1'));assert.equal(f.creates.length,1);}
});
await test('portal retrieves exact existing AARO customer and returns to AARO without credit writes',async()=>{
 const f=fixture();assert.equal((await f.client.portal(owner,{returnTo:'aaro'})).url,'https://billing.stripe.com/p/Fixture');assert.equal(f.creates[0].p.return_url,'https://aaroglobal.com/account');assert(f.writes.every(x=>x.name==='aaro_billing_customer_v1'));
});
