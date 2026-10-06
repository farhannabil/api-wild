// Offline canonical Stripe fixtures. No credential discovery or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import catalog from '../../../lib/aaro-plans.json' with {type:'json'};
import {createAaroStripeProjection} from '../runtime/aaro-stripe-projection.mjs';
import {STRIPE_ACCOUNTS} from '../runtime/stripe-financial-projection.mjs';
const now=2000000000,secret='whsec_OfflineFixtureNotARealCredential';
const checkout='12345678-1234-4123-8123-123456789abc',user='22345678-1234-4123-8123-123456789abc';
const plan=catalog.plans.find(x=>x.id==='global-starter'),lst=data=>({object:'list',has_more:false,data});
function envelope(type='invoice.paid',id='in_Fixture',extra={}){
 const rawBody=Buffer.from(JSON.stringify({id:'evt_Fixture',type,livemode:true,data:{object:{id,metadata:{owner:'ATTACKER'}}},...extra}));
 return {rawBody,signature:'t='+now+',v1='+createHmac('sha256',secret).update(now+'.').update(rawBody).digest('hex')};
}
function fixture(config={}){
 const calls=[],projects=[],reads=[],b={id:checkout,owner:'live:supabase:'+user,customer_id:'cus_Fixture',subscription_id:null,session_id:null,plan_reference:plan.id,plan:structuredClone(plan)};
 const price={id:plan.priceId,livemode:true,active:true,currency:'usd',unit_amount:1500,product:plan.productId,type:'recurring',recurring:{interval:'month',interval_count:1}};
 const objects={account:{id:STRIPE_ACCOUNTS.live},['prices/'+plan.priceId]:price,
  ['products/'+plan.productId]:{id:plan.productId,livemode:true,active:true,metadata:{brand:'aaro',plan:plan.id,credits:String(plan.credits)}},
  'subscriptions/sub_Fixture':{id:'sub_Fixture',livemode:true,customer:'cus_Fixture',status:'active',metadata:{aaro_checkout:checkout},items:lst([{quantity:1,price}])},
  'invoices/in_Fixture':{id:'in_Fixture',livemode:true,customer:'cus_Fixture',currency:'usd',status:'paid',parent:{subscription_details:{subscription:'sub_Fixture'}},
   billing_reason:'subscription_cycle',subtotal:1500,total:1500,amount_paid:1500,amount_remaining:0,total_discount_amounts:[],pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,starting_balance:0,
   lines:lst([{quantity:1,amount:1500,parent:{subscription_item_details:{proration:false}},pricing:{price_details:{price:plan.priceId}},period:{start:now-10,end:now+2591990}}])},
  'invoice_payments?invoice=in_Fixture&status=paid&limit=100':lst([{id:'inpay_Fixture',livemode:true,invoice:'in_Fixture',status:'paid',currency:'usd',amount_paid:1500,payment:{type:'payment_intent',payment_intent:'pi_Fixture'}}]),
  'payment_intents/pi_Fixture':{id:'pi_Fixture',livemode:true,status:'succeeded',customer:'cus_Fixture',currency:'usd',amount_received:1500,latest_charge:'ch_Fixture'},
  'charges/ch_Fixture':{id:'ch_Fixture',livemode:true,status:'succeeded',customer:'cus_Fixture',currency:'usd',paid:true,captured:true,disputed:false,amount:1500,amount_refunded:0,payment_intent:'pi_Fixture'},
  'refunds?charge=ch_Fixture&limit=100':lst([]),
  'checkout/sessions/cs_live_Fixture':{id:'cs_live_Fixture',livemode:true,mode:'subscription',client_reference_id:checkout,metadata:{aaro_checkout:checkout},status:'complete',customer:'cus_Fixture'},
  'refunds/re_Fixture':{id:'re_Fixture',charge:'ch_Fixture',currency:'usd',status:'pending'},
  'disputes/dp_Fixture':{id:'dp_Fixture',livemode:true,charge:'ch_Fixture'},
  'invoice_payments?limit=100&payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_Fixture':lst([{id:'inpay_Fixture',livemode:true,invoice:'in_Fixture',payment:{type:'payment_intent',payment_intent:'pi_Fixture'}}])};
 const state={b,bangladeshEligible:true,ack:true};
 const client=createAaroStripeProjection({enabled:true,billingMode:'live',accountId:STRIPE_ACCOUNTS.live,stripeSecretKey:'rk_live_OFFLINEFIXTURENOTREAL',webhookSecret:secret,nowSeconds:()=>now,timeoutMs:1000,
  fetchImpl:async(url,options)=>{calls.push({url,options});const path=url.substring('https://api.stripe.com/v1/'.length);if(!Object.hasOwn(objects,path))throw Error('Unexpected fixture path');return Response.json(objects[path]);},
  rpc:async(name,p)=>{if(name==='aaro_stripe_binding_read_v1'){reads.push(p);return {binding:state.b,bangladeshEligible:state.bangladeshEligible};}projects.push({name,p});return {applied:state.ack,replayed:false,eventId:p.p_event_id};},...config});
 return {client,objects,calls,projects,reads,state};
}
await test('disabled adapter and invalid signature/envelope cannot read or grant',async()=>{
 let n=0;await assert.rejects(createAaroStripeProjection({fetchImpl:()=>n++,rpc:()=>n++}).handle(envelope()));assert.equal(n,0);
 const f=fixture();for(const input of [{...envelope(),signature:'bad'},{...envelope(),rawBody:Buffer.alloc(1000001)},envelope(undefined,undefined,{livemode:false}),envelope(undefined,undefined,{account:'acct_other'}),envelope('unrelated.event')])await assert.rejects(f.client.handle(input));assert.equal(f.calls.length,0);assert.equal(f.projects.length,0);
});
await test('canonical invoice and native processor graph grant exact bound AARO plan only',async()=>{
 const f=fixture();assert.deepEqual(await f.client.handle(envelope()),{received:true,replayed:false});
 assert.equal(f.projects.length,1);assert.equal(f.projects[0].name,'aaro_stripe_project_v1');const fact=f.projects[0].p.p_fact;
 assert.equal(fact.product,'aaro');assert.equal(fact.checkoutId,checkout);assert.equal(fact.amount,1500);assert.equal(fact.processorVerified,true);assert.equal(fact.periodStart,now-10);
 assert.deepEqual(f.reads,[{p_subscription:'sub_Fixture',p_checkout:checkout}]);
 assert(!JSON.stringify(f.projects).includes('ATTACKER'));assert(!JSON.stringify(f.projects).includes('rk_live'));
 assert(f.calls.every(x=>x.options.method==='GET'&&x.options.redirect==='error'&&x.options.cache==='no-store'));
});
await test('wrong original account and unbound other brand never project',async()=>{
 const f=fixture();f.objects.account.id='acct_other';await assert.rejects(f.client.handle(envelope()));assert.equal(f.calls.length,1);assert.equal(f.projects.length,0);
 const other=fixture();other.state.b=null;assert.deepEqual(await other.client.handle(envelope()),{received:true,ignored:true});assert.equal(other.projects.length,0);
});
await test('native customer, price, product, mode, monthly plan and units cannot drift',async()=>{
 for(const [path,patch] of [['subscriptions/sub_Fixture',{customer:'cus_other'}],['subscriptions/sub_Fixture',{livemode:false}],['subscriptions/sub_Fixture',{pause_collection:{behavior:'void'}}],['prices/'+plan.priceId,{unit_amount:1400}],['prices/'+plan.priceId,{recurring:{interval:'year',interval_count:1}}],['products/'+plan.productId,{metadata:{brand:'apiwild',plan:plan.id,credits:'300000'}}]]){
  const f=fixture();Object.assign(f.objects[path],patch);await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
 }
 const f=fixture();f.state.b.plan.credits++;await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
});
await test('credits require complete invoice, no discounts/proration/credit notes and bounded period',async()=>{
 for(const patch of [{starting_balance:-1},{total_discount_amounts:[{amount:1}]},{post_payment_credit_notes_amount:1},{amount_paid:1499},{billing_reason:'manual'},{lines:{...lst([]),has_more:true}}]){
  const f=fixture();Object.assign(f.objects['invoices/in_Fixture'],patch);await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
 }
 for(const patch of [{period:{start:now,end:now+33*86400}},{parent:{subscription_item_details:{proration:true}}},{quantity:2}]){const f=fixture();Object.assign(f.objects['invoices/in_Fixture'].lines.data[0],patch);await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);}
});
await test('failed/late invoices and subscription events cannot manufacture a paid fact',async()=>{
 for(const type of ['invoice.payment_failed','invoice.voided']){const f=fixture();await f.client.handle(envelope(type));assert.equal(f.projects[0].p.p_fact.paid,false);assert.equal(f.projects[0].p.p_fact.processorVerified,false);assert(!f.calls.some(x=>x.url.includes('payment_intents/')));}
 const f=fixture();await f.client.handle(envelope('customer.subscription.updated','sub_Fixture'));assert.equal(f.projects[0].p.p_operation,'subscription');assert.equal(f.projects[0].p.p_fact.paid,undefined);
});
await test('insufficient, duplicate, partial, mixed processor receipts refuse fulfillment',async()=>{
 const pay='invoice_payments?invoice=in_Fixture&status=paid&limit=100';
 for(const patch of [{has_more:true},{data:[]},{data:[{id:'inpay_Fixture',livemode:false}]},{data:[{id:'inpay_Fixture',livemode:true,invoice:'in_other',status:'paid',currency:'usd',amount_paid:1500}]}]){const f=fixture();Object.assign(f.objects[pay],patch);await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);}
 const f=fixture();f.objects[pay].data.push(f.objects[pay].data[0]);await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
});
await test('canonical charge identity, settled amount, captured state and refunds are independently checked',async()=>{
 for(const patch of [{id:'ch_other'},{amount_refunded:1},{disputed:true},{captured:false},{amount:1499},{customer:'cus_other'}]){const f=fixture();Object.assign(f.objects['charges/ch_Fixture'],patch);await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);}
 const f=fixture();f.objects['refunds?charge=ch_Fixture&limit=100'].data=[{id:'re_Fixture',charge:'ch_Fixture',currency:'usd',status:'pending'}];await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
});
await test('checkout completion is only a binding receipt, never credit funding',async()=>{
 const f=fixture();await f.client.handle(envelope('checkout.session.completed','cs_live_Fixture'));assert.equal(f.projects[0].p.p_operation,'checkout');assert.equal(f.projects[0].p.p_fact.paid,undefined);
 const bad=fixture();bad.objects['checkout/sessions/cs_live_Fixture'].id='cs_live_other';await assert.rejects(bad.client.handle(envelope('checkout.session.completed','cs_live_Fixture')));assert.equal(bad.projects.length,0);
});
await test('one native charge cannot be counted twice, or substituted for a different PaymentIntent',async()=>{
 const f=fixture(),pay=f.objects['invoice_payments?invoice=in_Fixture&status=paid&limit=100'];pay.data.push({...pay.data[0],id:'inpay_other'});Object.assign(f.objects['invoices/in_Fixture'],{total:3000,amount_paid:3000});
 await assert.rejects(f.client.handle(envelope()));assert.equal(f.projects.length,0);
 const other=fixture();other.objects['charges/ch_Fixture'].payment_intent='pi_other';await assert.rejects(other.client.handle(envelope()));assert.equal(other.projects.length,0);
});
await test('refunds/disputes are native invoice holds with no automatic credit release',async()=>{
 for(const [type,id] of [['refund.created','re_Fixture'],['charge.dispute.closed','dp_Fixture'],['charge.refunded','ch_Fixture']]){
  const f=fixture();await f.client.handle(envelope(type,id));assert.equal(f.projects[0].p.p_operation,'hold');assert.equal(f.projects[0].p.p_fact.invoiceId,'in_Fixture');assert.equal(f.projects[0].p.p_fact.sourceReference,id);
 }
});
await test('partial/mixed risk allocation or wrong canonical charge cannot hold another owner',async()=>{
 const path='invoice_payments?limit=100&payment%5Btype%5D=payment_intent&payment%5Bpayment_intent%5D=pi_Fixture';
 for(const patch of [{has_more:true},{data:[{id:'inpay_Fixture',livemode:true,invoice:'in_Fixture',payment:{type:'payment_intent',payment_intent:'pi_other'}}]}]){const f=fixture();Object.assign(f.objects[path],patch);await assert.rejects(f.client.handle(envelope('refund.created','re_Fixture')));assert.equal(f.projects.length,0);}
 const f=fixture();f.objects['charges/ch_Fixture'].id='ch_other';await assert.rejects(f.client.handle(envelope('refund.created','re_Fixture')));assert.equal(f.projects.length,0);
});
await test('durable RPC ack and bounded errors are required; secrets never escape',async()=>{
 const f=fixture();f.state.ack=false;await assert.rejects(f.client.handle(envelope()),/aaro_projection_unverified/);
 const leak=fixture({rpc:async()=>{throw Error('PRIVATE SECRET');}});await assert.rejects(leak.client.handle(envelope()),error=>error.message==='aaro_stripe_unverified');
});
