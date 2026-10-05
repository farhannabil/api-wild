import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setup} from './lifecycle.test.mjs';
const catalog=JSON.parse(fs.readFileSync('lib/aaro-plans.json','utf8'));
const config={STRIPE_SECRET_KEY:'rk_live_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',AARO_BILLING_ENABLED:'true',WEBHOOK_INGRESS_VERIFIED:'true'};
const owner='live:supabase:fixture',user={id:owner,email:'fixture@example.test'};
function fixture(plan=catalog.plans.find(p=>p.id==='global-starter')){
 const a=setup(config),start=Math.floor(Date.now()/1000)-60,end=start+2592000;
 const session={id:'cs_live_aaro',mode:'subscription',url:'https://checkout.stripe.com/c/pay/cs_live_aaro',status:'open',customer:'cus_fixture',livemode:true};
 const sub={id:'sub_aaro',customer:'cus_fixture',status:'active',livemode:true,metadata:{},items:{has_more:false,data:[{quantity:1,price:{id:plan.priceId,currency:plan.currency,unit_amount:plan.amount,recurring:{interval:'month',interval_count:1}}}]}};
 const invoice={id:'in_aaro',parent:{subscription_details:{subscription:'sub_aaro'}},customer:'cus_fixture',livemode:true,status:'paid',billing_reason:'subscription_create',currency:plan.currency,subtotal:plan.amount,total:plan.amount,amount_paid:plan.amount,amount_remaining:0,lines:{has_more:false,data:[{quantity:1,amount:plan.amount,pricing:{price_details:{price:plan.priceId}},period:{start,end}}]}};
 const payment={invoice:'in_aaro',status:'paid',amount_paid:plan.amount,currency:plan.currency,livemode:true,payment:{type:'payment_intent',payment_intent:'pi_aaro'}};
 a.setResponder((url,opts)=>{
  if(url.endsWith('/account'))return Response.json({id:catalog.account,charges_enabled:true});
  if(url.endsWith('/checkout/sessions')&&opts.method==='POST'){session.client_reference_id=opts.body.get('client_reference_id');session.metadata={aaro_checkout:session.client_reference_id};sub.metadata.aaro_checkout=session.client_reference_id;return Response.json(session);}
  if(url.includes('/checkout/sessions/'))return Response.json(session);
  if(url.includes('/subscriptions/'))return Response.json(sub);
  if(url.includes('/invoices/'))return Response.json(invoice);
  if(url.includes('/invoice_payments?'))return Response.json({has_more:false,data:[payment]});
  return null;
 });
 const billing=a.load('lib/aaro-billing.ts');
 return {...a,billing,plan,session,sub,invoice,payment,event:(type,obj)=>billing.reconcileAaroEvent({type,data:{object:obj}})};
}
test('AARO exact seven monthly plans; no international free plan',()=>{
 assert.deepEqual(catalog.plans.map(p=>[p.id,p.amount,p.credits]),[['bd-free',0,25000],['bd-starter',45600,150000],['bd-plus',78900,399000],['bd-max',123400,1200000],['global-starter',1500,300000],['global-plus',7900,750000],['global-max',13900,3000000]]);
});

test('AARO checkout returns to AARO without requiring enterprise profile and refuses arbitrary return origins',async()=>{
 const f=fixture(),route=f.load('app/api/aaro/checkout/route.ts');
 const response=await route.POST(new Request('https://apiwild.com/api/aaro/checkout',{method:'POST',headers:{origin:'https://apiwild.com','content-type':'application/json',authorization:'Bearer fixture'},body:JSON.stringify({plan:'global-starter',returnTo:'aaro'})}));
 assert.equal(response.status,200);
 assert.equal(f.calls.some(c=>c.url.includes('/rest/v1/customer_profiles')),false);
 const body=f.calls.find(c=>c.url.endsWith('/checkout/sessions')&&c.opts.method==='POST').opts.body;
 assert.equal(body.get('success_url'),'https://aaroglobal.com/app/?billing=returned');
 assert.equal(body.get('cancel_url'),'https://aaroglobal.com/app/?billing=cancelled');
 assert.equal(f.billing.aaroReturnUrl('https://apiwild.com','https://evil.test'),'https://apiwild.com/aaro/billing');
});
test('AARO payment wiring is independent of AI provider or API WILD commercial gate, but requires its own activation',async()=>{
 const f=fixture();assert.equal(f.billing.aaroConfig().enabled,true);assert.equal(f.load('lib/billing.ts').billingConfig().enabled,false);
 f.env.AARO_BILLING_ENABLED='false';await assert.rejects(()=>f.billing.aaroCheckout(user,'global-starter'));assert.equal(f.calls.length,0);
});
for(const plan of catalog.plans)test(`AARO ${plan.id}: trusted regional eligibility, server price, idempotent subscription checkout`,async()=>{
 const f=fixture(plan);
 if(plan.region==='BD'){
  await assert.rejects(()=>f.billing.aaroCheckout(user,plan.id));assert.equal(f.calls.length,0);
  f.sql.prepare('INSERT INTO aaro_region_evidence(user_id,country,evidence_reference,expires_at) VALUES(?,?,?,?)').run(owner,'BD','verified-payment-reference',new Date(Date.now()+86400e3).toISOString());
 }
 await f.billing.aaroCheckout(user,plan.id);await f.billing.aaroCheckout(user,plan.id);
 const calls=f.calls.filter(c=>c.url.endsWith('/checkout/sessions')&&c.opts.method==='POST');assert.equal(calls.length,1);
 const b=calls[0].opts.body;assert.equal(b.get('mode'),'subscription');assert.equal(b.get('line_items[0][price]'),plan.priceId);assert.equal(b.get('branding_settings[display_name]'),'AARO');assert.equal(b.has('payment_method_types[0]'),false);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_checkouts').get().n,1);
 await f.event('invoice.paid',f.invoice);await f.event('invoice.paid',f.invoice);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_credit_periods').get().n,1);assert.equal(f.sql.prepare('SELECT credits FROM aaro_credit_periods').get().credits,plan.credits);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,0);
});
test('AARO unpaid, failed and wrong-owner invoices never grant credits; cancellation removes allocation visibility',async()=>{
 const f=fixture();await f.billing.aaroCheckout(user,f.plan.id);
 f.invoice.status='open';f.sub.status='past_due';await f.event('invoice.payment_failed',f.invoice);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_credit_periods').get().n,0);
 f.invoice.status='paid';f.sub.status='active';f.invoice.customer='cus_wrong';await assert.rejects(()=>f.event('invoice.paid',f.invoice));assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_credit_periods').get().n,0);
 f.invoice.customer='cus_fixture';await f.event('invoice.paid',f.invoice);assert.equal((await f.billing.aaroStatus(owner)).creditPeriods.length,1);assert.equal((await f.billing.aaroStatus('another-owner')).creditPeriods.length,0);
 f.sub.status='canceled';await f.event('customer.subscription.deleted',f.sub);assert.equal((await f.billing.aaroStatus(owner)).creditPeriods.length,0);assert.equal(f.sql.prepare('SELECT active_owner FROM aaro_checkouts').get().active_owner,null);
});
test('AARO refund/dispute arriving before paid invoice holds the later entitlement; duplicate risk events are harmless',async()=>{
 const f=fixture();await f.billing.aaroCheckout(user,f.plan.id);
 await f.event('charge.refunded',{payment_intent:'pi_aaro',amount_refunded:100});await f.event('charge.dispute.created',{payment_intent:'pi_aaro'});
 await f.event('invoice.paid',f.invoice);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_credit_periods').get().n,1);assert.equal((await f.billing.aaroStatus(owner)).creditPeriods.length,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_payment_holds').get().n,1);
});
test('AARO modified invoice amount, currency, price, unconfirmed payment and pagination fail closed',async()=>{
 for(const mutation of[f=>f.invoice.subtotal=1,f=>f.invoice.currency='eur',f=>f.invoice.lines.data[0].pricing.price_details.price='price_foreign',f=>f.payment.status='open',f=>f.invoice.lines.has_more=true]){
  const f=fixture();await f.billing.aaroCheckout(user,f.plan.id);mutation(f);await assert.rejects(()=>f.event('invoice.paid',f.invoice));assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_credit_periods').get().n,0);
 }
});
test('AARO expired checkout releases reservation, completed checkout binds subscription without granting credits',async()=>{
 const f=fixture();await f.billing.aaroCheckout(user,f.plan.id);f.session.status='complete';f.session.subscription='sub_aaro';await f.event('checkout.session.completed',f.session);assert.equal(f.sql.prepare('SELECT subscription_id FROM aaro_checkouts').get().subscription_id,'sub_aaro');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_credit_periods').get().n,0);await assert.rejects(()=>f.billing.aaroCheckout(user,f.plan.id));
 const g=fixture();await g.billing.aaroCheckout(user,g.plan.id);g.session.status='expired';await g.event('checkout.session.expired',g.session);assert.equal(g.sql.prepare('SELECT active_owner FROM aaro_checkouts').get().active_owner,null);
});
test('AARO route rejects forged identity, cross-origin and browser-only Bangladesh eligibility',async()=>{
 const f=fixture(),route=f.load('app/api/aaro/checkout/route.ts');
 function request(origin='https://apiwild.com',auth=true){return new Request('https://apiwild.com/api/aaro/checkout',{method:'POST',headers:{origin,'content-type':'application/json',...(auth?{authorization:'Bearer fixture'}:{'oai-authenticated-user-id':'fixture'})},body:JSON.stringify({plan:'bd-max',country:'BD',eligible:true,price:1})});}
 assert.equal((await route.POST(request('https://evil.test'))).status,403);assert.equal((await route.POST(request(undefined,false))).status,401);assert.equal((await route.POST(request())).status,403);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_checkouts').get().n,0);
});
test('AARO old stored session is reconciled before age guard, so missed expiry webhooks do not lock customers out',async()=>{
 const f=fixture();await f.billing.aaroCheckout(user,f.plan.id);f.sql.prepare('UPDATE aaro_checkouts SET created_at=?').run('2020-01-01T00:00:00Z');f.session.status='expired';await assert.rejects(()=>f.billing.aaroCheckout(user,f.plan.id));assert.equal(f.sql.prepare('SELECT active_owner FROM aaro_checkouts').get().active_owner,null);
});
test('AARO expired checkout releases reservation even when a different plan is selected',async()=>{
 const f=fixture();await f.billing.aaroCheckout(user,f.plan.id);f.session.status='expired';await assert.rejects(()=>f.billing.aaroCheckout(user,'global-plus'));assert.equal(f.sql.prepare('SELECT active_owner FROM aaro_checkouts').get().active_owner,null);
});
test('AARO monthly renewal allocates once per invoice, failure adds nothing and recovery is idempotent',async()=>{
 const f=fixture();await f.billing.aaroCheckout(user,f.plan.id);await f.event('invoice.paid',f.invoice);
 f.invoice.id='in_renewal';f.invoice.billing_reason='subscription_cycle';f.invoice.status='open';f.sub.status='past_due';await f.event('invoice.payment_failed',f.invoice);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_credit_periods').get().n,1);
 f.invoice.status='paid';f.sub.status='active';f.payment.invoice='in_renewal';await f.event('invoice.paid',f.invoice);await f.event('invoice.paid',f.invoice);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_credit_periods').get().n,2);
});
test('AARO portal uses its cancellation-enabled configuration and authenticated customer only',async()=>{
 const f=fixture();await f.billing.aaroCheckout(user,f.plan.id);await f.event('customer.subscription.created',f.sub);
 f.setSession({url:'https://billing.stripe.com/p/session_fixture'});
 const r=new Request('https://apiwild.com/api/aaro/portal',{method:'POST',headers:{origin:'https://apiwild.com','content-type':'application/json',authorization:'Bearer fixture'},body:JSON.stringify({customer:'cus_wrong'})});
 assert.equal((await f.load('app/api/aaro/portal/route.ts').POST(r)).status,200);
 const call=f.calls.find(c=>c.url.endsWith('/billing_portal/sessions'));assert.equal(call.opts.body.get('customer'),'cus_fixture');assert.equal(call.opts.body.get('configuration'),JSON.parse(fs.readFileSync('lib/brand-portals.json')).aaro);
});
