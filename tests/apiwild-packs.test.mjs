import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setup} from './lifecycle.test.mjs';
const catalog=JSON.parse(fs.readFileSync('lib/apiwild-packs.json','utf8'));
const config={STRIPE_SECRET_KEY:'rk_live_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',BILLING_ENABLED:'true',WEBHOOK_INGRESS_VERIFIED:'true',COMMERCE_READY:'true'};
function request(pack,requestId=crypto.randomUUID()){return new Request('https://apiwild.com/api/billing/checkout',{method:'POST',headers:{origin:'https://apiwild.com',authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({pack,requestId,amountCents:500,price:'price_attacker'})});}
test('approved four packs have exact named USD credit amounts and match the public catalog',()=>{
 assert.deepEqual(catalog.packs.map(p=>[p.id,p.name,p.cents]),[['smart','SmarT',3300],['nerd','NeRD',10100],['newton','Newton',23400],['alien','Alien',34500]]);
 const publicPacks=setup().load('lib/gateway-catalog.ts').creditPacks;
 assert.deepEqual(JSON.parse(JSON.stringify(publicPacks.map(p=>[p.id,p.name,p.cents]))),catalog.packs.map(p=>[p.id,p.name,p.cents]));
});
for(const pack of catalog.packs)test(`${pack.name}: fixed live price, original account, branding, retry and exact wallet credit (mocked Stripe)`,async()=>{
 const a=setup(config);a.setResponder(url=>url.endsWith('/account')?Response.json({id:catalog.account,charges_enabled:true}):null);
 a.setSession({id:'cs_live_pack',url:'https://checkout.stripe.com/c/pay/cs_live_pack',status:'open'});
 const route=a.load('app/api/billing/checkout/route.ts'),id=crypto.randomUUID();
 assert.equal((await route.POST(request(pack.id,id))).status,200);
 const call=a.calls.find(c=>c.url.endsWith('/checkout/sessions')&&c.opts.method==='POST'),body=call.opts.body;
 assert.equal(body.get('line_items[0][price]'),pack.priceId);assert.equal(body.has('line_items[0][price_data][unit_amount]'),false);
 assert.equal(body.get('branding_settings[display_name]'),'API WILD');assert.equal(body.get('mode'),'payment');assert.equal(body.has('payment_method_types[0]'),false);
 assert.equal((await route.POST(request(pack.id,id))).status,200);
 assert.equal(a.calls.filter(c=>c.url.endsWith('/checkout/sessions')&&c.opts.method==='POST').length,1);
 const order=a.sql.prepare('SELECT * FROM billing_orders').get();assert.equal(order.amount_cents,pack.cents);
 a.setSession({id:'cs_live_pack',mode:'payment',status:'complete',payment_status:'paid',client_reference_id:order.id,metadata:{order_id:order.id},currency:'usd',amount_subtotal:pack.cents,amount_total:pack.cents,total_details:{amount_tax:0},livemode:true,payment_intent:'pi_pack'});
 const billing=a.load('lib/billing.ts');await billing.reconcileSession('cs_live_pack',order.user_id);await billing.reconcileSession('cs_live_pack',order.user_id);
 assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,1);assert.equal(a.sql.prepare('SELECT SUM(amount_cents) cents FROM credit_ledger').get().cents,pack.cents);
});
test('another Stripe merchant or disabled commercial gate cannot create a pack session',async()=>{
 const a=setup(config);a.setSession({id:'wrong',charges_enabled:true});
 assert.equal((await a.load('app/api/billing/checkout/route.ts').POST(request('smart'))).status,503);
 assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM billing_orders').get().n,0);
 a.env.BILLING_ENABLED='false';a.calls.length=0;
 assert.equal((await a.load('app/api/billing/checkout/route.ts').POST(request('smart'))).status,503);
 assert.equal(a.calls.filter(c=>c.url.includes('api.stripe.com')).length,0);
});
