import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export function setup(config={}){const sql=new DatabaseSync(':memory:');for(const f of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(fs.readFileSync('drizzle/'+f,'utf8'));
const db={prepare(query){let args=[];return{bind(...a){args=a;return this},async first(){return sql.prepare(query).get(...args)||null},async all(){return {results:sql.prepare(query).all(...args)}},async run(){return{meta:{changes:Number(sql.prepare(query).run(...args).changes)}}}}} ,async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
const env={DB:db,SUPABASE_URL:'https://supabase.test',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',...config},cache={},calls=[];let session={};let responder=null;let failBatch=false;const realBatch=db.batch.bind(db);db.batch=async s=>{if(failBatch)throw Error('fixture database unavailable');return realBatch(s)};
function load(path){if(cache[path])return cache[path];if(path.endsWith('.json'))return JSON.parse(fs.readFileSync(path));const js=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,resolveJsonModule:true}}).outputText;const module={exports:{}};vm.runInNewContext(js,{module,exports:module.exports,require:n=>n==='cloudflare:workers'?{env}:n.startsWith('@/')?load(n.slice(2)+(n.endsWith('.json')?'':'.ts')):require(n),Response,Request,URL,URLSearchParams,TextDecoder,TextEncoder,Uint8Array,crypto,AbortSignal,console,Date,Error,SyntaxError,Set,fetch:async(url,opts)=>{calls.push({url,opts});if(responder){const response=await responder(url,opts);if(response)return response;}if(url.endsWith('/auth/v1/user'))return Response.json({id:opts.headers.authorization.slice(7),email:'fixture@example.test',email_confirmed_at:'2026-01-01'});if(url.includes('/rest/v1/customer_profiles'))return Response.json([{onboarding_completed_at:'2026-01-01'}]);if(url.endsWith('/customers'))return Response.json({id:'cus_fixture'});return Response.json(session)}},{filename:path});cache[path]=module.exports;return module.exports}
return{sql,env,db,calls,load,setSession:s=>session=s,setResponder:r=>responder=r,failBatch:v=>failBatch=v};}
function req(path,method='GET',body,user='fixture-a',origin='https://example.test'){const headers={};if(user){headers['oai-authenticated-user-id']=user;headers['oai-authenticated-user-email']=user+'@example.test';if(path.startsWith('/api/billing'))headers.authorization='Bearer '+user}if(method!=='GET'){headers.origin=origin;headers['content-type']='application/json'}return new Request('https://example.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)})}
const profile={name:'Fixture',company:'Example',budget:100,accountType:'company',domain:'example.test',phone:'',country:'CA',building:['Coding agent','Automations'],compliance:['DPA'],project:'Test integration'};
async function onboard(a,user='fixture-a'){assert.equal((await a.load('app/api/onboarding/route.ts').POST(req('/api/onboarding','POST',profile,user))).status,200)}
test('onboarding is atomic, tenant-scoped and preserves saved stacks',async()=>{const a=setup();await onboard(a);a.sql.prepare('UPDATE profiles SET stack=? WHERE user_id=?').run('["fast"]','fixture-a');await onboard(a);assert.equal(a.sql.prepare('SELECT stack FROM profiles').get().stack,'["fast"]');assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM preferences').get().n,1);a.failBatch(true);const response=await a.load('app/api/onboarding/route.ts').POST(req('/api/onboarding','POST',{...profile,name:'Changed'}));assert.equal(response.status,503);assert.equal(a.sql.prepare('SELECT name FROM profiles').get().name,'Fixture');assert.equal((await a.load('app/api/onboarding/route.ts').POST(req('/api/onboarding','POST',profile,null))).status,401)});
test('key lifecycle: secret shown once, digest stored, isolated, revoked and expired keys fail',async()=>{const a=setup();await onboard(a);const keys=a.load('app/api/keys/route.ts'),auth=a.load('lib/key-auth.ts');const create=await keys.POST(req('/api/keys','POST',{name:'CI',days:30}));assert.equal(create.status,201);const secret=(await create.json()).key;assert.match(secret,/^lx_[a-f0-9]{64}$/);const row=a.sql.prepare('SELECT * FROM api_keys').get();assert.notEqual(row.hash,secret);const listed=await(await keys.GET(req('/api/keys'))).json();assert.ok(!JSON.stringify(listed).includes(secret));assert.ok(!('hash' in listed.keys[0]));assert.equal((await(await keys.GET(req('/api/keys','GET',undefined,'fixture-b'))).json()).keys.length,0);const keyReq=()=>new Request('https://example.test/v1/models',{headers:{authorization:'Bearer '+secret}});assert.equal((await auth.keyIdentity(keyReq())).id,'fixture-a');assert.equal((await keys.DELETE(req('/api/keys','DELETE',{id:row.id},'fixture-b'))).status,404);a.sql.prepare('UPDATE api_keys SET expires_at=?').run('2000-01-01T00:00:00.000Z');assert.equal(await auth.keyIdentity(keyReq()),null);a.sql.prepare('UPDATE api_keys SET expires_at=?').run('2099-01-01T00:00:00.000Z');assert.equal((await keys.DELETE(req('/api/keys','DELETE',{id:row.id}))).status,200);assert.equal(await auth.keyIdentity(keyReq()),null)});
test('active key quota and cross-origin protection',async()=>{const a=setup();await onboard(a);const keys=a.load('app/api/keys/route.ts');for(let i=0;i<20;i++)assert.equal((await keys.POST(req('/api/keys','POST',{name:'Key '+i,days:7}))).status,201);assert.equal((await keys.POST(req('/api/keys','POST',{name:'Excess',days:7}))).status,409);assert.equal((await keys.POST(req('/api/keys','POST',{name:'Cross-origin',days:7},'fixture-a','https://evil.test'))).status,403)});
test('usage totals, filters and rows remain tenant scoped',async()=>{const a=setup();const now=new Date().toISOString();for(const [id,u,cost]of[['a','fixture-a',1234567],['b','fixture-b',9000000]])a.sql.prepare('INSERT INTO usage_events(id,user_id,model,provider,status,cost_micros,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,u,'fixture-model','fixture-provider','success',cost,12,8,now);const route=a.load('app/api/usage/route.ts');const data=await(await route.GET(req('/api/usage?days=7'))).json();assert.equal(data.totals.calls,1);assert.equal(data.totals.cost_micros,1234567);assert.equal(data.totals.tokens,20);assert.equal(data.events[0].id,'a');assert.equal((await(await route.GET(req('/api/usage?provider=missing'))).json()).totals.calls,0);assert.equal((await route.GET(req('/api/usage','GET',undefined,null))).status,401)});
test('checkout stays disabled without credentials and verified webhook ingress',async()=>{const a=setup();const route=a.load('app/api/billing/checkout/route.ts');assert.equal((await route.POST(req('/api/billing/checkout','POST',{}))).status,503);assert.equal(a.calls.filter(c=>c.url.includes("api.stripe.com")).length,0);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM billing_orders').get().n,0);assert.equal((await route.POST(req('/api/billing/checkout','POST',{},null))).status,401)});
function paidFixture(a){const id=crypto.randomUUID(),sessionId='cs_test_fixture123';a.sql.prepare('INSERT INTO billing_orders(id,user_id,request_id,pack,amount_cents,currency,session_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'fixture-a',crypto.randomUUID(),'starter',2500,'usd',sessionId,'checkout',new Date().toISOString());const s={id:sessionId,mode:'payment',status:'complete',payment_status:'paid',client_reference_id:id,metadata:{order_id:id},amount_total:2500,currency:'usd',livemode:false,payment_intent:'pi_fixture123'};a.setSession(s);return {id,sessionId,s};}
test('payment verification rejects unpaid, wrong owner, amount, currency and live mode',async()=>{const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture'}),f=paidFixture(a),billing=a.load('lib/billing.ts');await assert.rejects(()=>billing.reconcileSession(f.sessionId,'fixture-b'));for(const patch of[{amount_total:1},{currency:'eur'},{livemode:true},{mode:'subscription'},{metadata:{order_id:'wrong'}}]){a.setSession({...f.s,...patch});await assert.rejects(()=>billing.reconcileSession(f.sessionId,'fixture-a'));}a.setSession({...f.s,payment_status:'unpaid'});assert.equal((await billing.reconcileSession(f.sessionId,'fixture-a')).status,'pending');assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,0)});
test('return and webhook reconciliation credit a session once; database failure remains retryable',async()=>{const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture'}),f=paidFixture(a),billing=a.load('lib/billing.ts');a.failBatch(true);await assert.rejects(()=>billing.reconcileSession(f.sessionId,'fixture-a'));assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,0);a.failBatch(false);await billing.reconcileSession(f.sessionId,'fixture-a');await billing.reconcileSession(f.sessionId);await billing.reconcileSession(f.sessionId);assert.equal(a.sql.prepare('SELECT COUNT(*) n,SUM(amount_cents) balance FROM credit_ledger').get().balance,2500);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,1)});
test('webhook signature rejects mutation, wrong secret and replay timestamp',async()=>{const a=setup(),b=a.load('lib/billing.ts');const raw='{"id":"evt_fixture"}',timestamp=Math.floor(Date.now()/1000),secret='whsec_fixture';const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw)));const sig=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');const header=`t=${timestamp},v1=${sig}`;assert.equal(await b.verifyStripeSignature(raw,header,secret),true);assert.equal(await b.verifyStripeSignature(raw+' ',header,secret),false);assert.equal(await b.verifyStripeSignature(raw,header,'wrong'),false);assert.equal(await b.verifyStripeSignature(raw,header,secret,timestamp+301),false)});
test('checkout retry uses the persisted price and reuses the stored session',async()=>{const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',BILLING_ENABLED:'true',WEBHOOK_INGRESS_VERIFIED:'true'});await onboard(a);const requestId=crypto.randomUUID(),orderId=crypto.randomUUID();a.sql.prepare('INSERT INTO billing_orders(id,user_id,request_id,pack,amount_cents,currency,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(orderId,'test:supabase:fixture-a',requestId,'starter',2100,'usd','created',new Date().toISOString());a.setSession({id:'cs_test_retry',url:'https://checkout.stripe.com/c/pay/cs_test_retry',status:'open'});const route=a.load('app/api/billing/checkout/route.ts');const body={pack:'starter',requestId,amount:1};assert.equal((await route.POST(req('/api/billing/checkout','POST',body))).status,200);assert.equal(a.calls.find(c=>c.url.endsWith('/checkout/sessions')).opts.body.get('line_items[0][price_data][unit_amount]'),'2100');assert.equal(a.calls.find(c=>c.url.endsWith('/checkout/sessions')).opts.body.get('payment_intent_data[metadata][order_id]'),orderId);assert.equal((await route.POST(req('/api/billing/checkout','POST',body))).status,200);assert.equal(a.calls.filter(x=>x.url.endsWith('/checkout/sessions')&&x.opts.method==='POST').length,1);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM billing_orders').get().n,1)});
test('refund-before-completion retries; duplicate refund reverses credit only once',async()=>{const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture'}),f=paidFixture(a),billing=a.load('lib/billing.ts');a.setSession({metadata:{order_id:f.id}});await assert.rejects(()=>billing.reconcileRefund({payment_intent:'pi_fixture123'}),e=>e.status===503);a.setSession(f.s);await billing.reconcileSession(f.sessionId);a.setResponder(url=>url.includes('/payment_intents/')?Response.json({metadata:{order_id:f.id},currency:'usd',livemode:false,amount_received:2500}):null);a.setSession({has_more:false,data:[{id:'re_fixture',status:'succeeded',amount:1000,currency:'usd'}]});await billing.reconcileRefund({payment_intent:'pi_fixture123'});await billing.reconcileRefund({payment_intent:'pi_fixture123'});assert.equal(a.sql.prepare('SELECT SUM(amount_cents) balance FROM credit_ledger').get().balance,1500);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,2)});

test('billing requires verified Supabase auth and rejects forged legacy headers',async()=>{
 const a=setup(),route=a.load('app/api/billing/route.ts');
 const forged=new Request('https://example.test/api/billing',{headers:{'oai-authenticated-user-id':'victim','oai-authenticated-user-email':'victim@example.test'}});
 assert.equal((await route.GET(forged)).status,401);
 a.setResponder(url=>url.endsWith('/auth/v1/user')?Response.json({error:'invalid'},{status:401}):null);
 assert.equal((await route.GET(req('/api/billing'))).status,401);
 a.setResponder(url=>url.endsWith('/auth/v1/user')?Response.json({id:'fixture-a',email:'fixture@example.test',is_anonymous:true}):null);
 assert.equal((await route.GET(req('/api/billing'))).status,403);
});

test('billing balances are isolated between customers and test/live modes',async()=>{
 const a=setup(),now=new Date().toISOString();
 for(const [id,user,amount] of [['1','test:supabase:fixture-a',2500],['2','live:supabase:fixture-a',10000],['3','test:supabase:fixture-b',90000]])a.sql.prepare('INSERT INTO credit_ledger VALUES(?,?,?,?,?,?,?,?)').run(id,user,id,id,amount,'usd','Fixture',now);
 const route=a.load('app/api/billing/route.ts');
 assert.equal((await(await route.GET(req('/api/billing'))).json()).availableCents,2500);
 a.env.STRIPE_SECRET_KEY='sk_live_fixture';
 assert.equal((await(await route.GET(req('/api/billing'))).json()).availableCents,10000);
});

test('checkout ignores supplied prices/customer and blocks cross-origin writes',async()=>{
 const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',BILLING_ENABLED:'true',WEBHOOK_INGRESS_VERIFIED:'true'});
 a.setSession({id:'cs_test_fixture',url:'https://checkout.stripe.com/c/pay/fixture',status:'open'});
 const route=a.load('app/api/billing/checkout/route.ts'),body={pack:'starter',requestId:crypto.randomUUID(),amount:1,customer:'cus_victim',email:'attacker@example.test',receipt_email:'attacker@example.test'};
 assert.equal((await route.POST(req('/api/billing/checkout','POST',body,'fixture-a','https://evil.test'))).status,403);
 assert.equal((await route.POST(req('/api/billing/checkout','POST',body))).status,200);
 const params=a.calls.find(c=>c.url.endsWith('/checkout/sessions')).opts.body;
 assert.equal(params.get('payment_method_types[0]'),null);assert.equal(params.get('adaptive_pricing[enabled]'),'false');assert.match(params.get('integration_identifier'),/^apiwild-credits-[a-z]{8}$/);assert.equal(a.calls.find(c=>c.url.endsWith('/checkout/sessions')).opts.headers['Stripe-Version'],'2026-08-26.dahlia');
 assert.equal(params.get('customer'),'cus_fixture');assert.equal(params.get('line_items[0][price_data][unit_amount]'),'2500');
 assert.equal(params.get('success_url'),'https://apiwild.com/console/billing?session_id={CHECKOUT_SESSION_ID}');
 assert.equal(params.get('invoice_creation[enabled]'),'true');
 assert.equal(params.get('payment_intent_data[receipt_email]'),'fixture@example.test');
 assert.equal(a.calls.find(c=>c.url.endsWith('/customers')).opts.body.get('email'),'fixture@example.test');
 a.env.STRIPE_SECRET_KEY='sk_live_fixture';
 assert.equal((await route.POST(req('/api/billing/checkout','POST',{...body,requestId:crypto.randomUUID()}))).status,503);
});

test('checkout refreshes a reused customer from verified email and retry avoids duplicate writes',async()=>{
 const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',BILLING_ENABLED:'true',WEBHOOK_INGRESS_VERIFIED:'true'});
 a.sql.prepare('INSERT INTO billing_customers VALUES(?,?,?)').run('test:supabase:fixture-a','cus_existing',new Date().toISOString());
 a.setResponder(url=>url.endsWith('/auth/v1/user')?Response.json({id:'fixture-a',email:'updated@example.test',email_confirmed_at:'2026-01-01'}):null);
 a.setSession({id:'cs_test_updated',url:'https://checkout.stripe.com/c/pay/updated',status:'open'});
 const route=a.load('app/api/billing/checkout/route.ts'),body={pack:'starter',requestId:crypto.randomUUID(),email:'attacker@example.test'};
 assert.equal((await route.POST(req('/api/billing/checkout','POST',body))).status,200);
 assert.equal(a.calls.find(c=>c.url.endsWith('/customers/cus_existing')).opts.body.get('email'),'updated@example.test');
 assert.equal(a.calls.find(c=>c.url.endsWith('/checkout/sessions')).opts.body.get('payment_intent_data[receipt_email]'),'updated@example.test');
 assert.equal((await route.POST(req('/api/billing/checkout','POST',body))).status,200);
 assert.equal(a.calls.filter(c=>c.url.endsWith('/customers/cus_existing')&&c.opts.method==='POST').length,1);
 assert.equal(a.calls.filter(c=>c.url.endsWith('/checkout/sessions')&&c.opts.method==='POST').length,1);
});

test('customer portal and receipts enforce owner mapping',async()=>{
 const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PORTAL_CONFIGURATION_ID:'bpc_fixture'}),now=new Date().toISOString();
 a.sql.prepare('INSERT INTO billing_customers VALUES(?,?,?)').run('test:supabase:fixture-a','cus_owner',now);
 a.setSession({url:'https://billing.stripe.com/p/session/fixture'});
 const portal=a.load('app/api/billing/portal/route.ts');
 assert.equal((await portal.POST(req('/api/billing/portal','POST',{customer:'cus_victim'}))).status,200);
 assert.equal(a.calls.find(c=>c.url.endsWith('billing_portal/sessions')).opts.body.get('customer'),'cus_owner');
 assert.equal((await portal.POST(req('/api/billing/portal','POST',{},'fixture-b'))).status,409);
 const f=paidFixture(a);a.sql.prepare('UPDATE billing_orders SET user_id=?,payment_intent=? WHERE id=?').run('test:supabase:fixture-a','pi_fixture',f.id);
 a.setSession({latest_charge:{receipt_url:'https://pay.stripe.com/receipts/fixture'}});
 const receipt=a.load('app/api/billing/receipt/route.ts');
 assert.equal((await receipt.GET(req('/api/billing/receipt?orderId='+f.id,'GET',undefined,'fixture-b'))).status,404);
 assert.equal((await receipt.GET(req('/api/billing/receipt?orderId='+f.id))).status,200);
});

async function signedEvent(event,secret='whsec_fixture'){
 const raw=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 return new Request('https://example.test/api/billing/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${sig}`},body:raw});
}
test('signed webhook credits without return, deduplicates, rejects wrong mode, retries DB failures',async()=>{
 const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture'}),f=paidFixture(a),route=a.load('app/api/billing/webhook/route.ts');
 const event={id:'evt_fixture',type:'checkout.session.completed',livemode:false,data:{object:f.s}};
 a.failBatch(true);assert.equal((await route.POST(await signedEvent(event))).status,503);
 assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM billing_events').get().n,0);
 a.failBatch(false);
 for(let i=0;i<3;i++)assert.equal((await route.POST(await signedEvent(event))).status,200);
 assert.equal(a.sql.prepare('SELECT SUM(amount_cents) n FROM credit_ledger').get().n,2500);
 assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM billing_events').get().n,1);
 assert.equal((await route.POST(await signedEvent({...event,id:'evt_wrongmode',livemode:true}))).status,400);
 assert.equal((await route.POST(await signedEvent(event,'whsec_wrong'))).status,400);
});

test('taxed partial/full refunds reverse only credits and cannot regress on old events',async()=>{
 const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture'}),f=paidFixture(a),b=a.load('lib/billing.ts');
 a.setSession({...f.s,amount_subtotal:2500,amount_total:2750,total_details:{amount_tax:250,amount_discount:0}});
 await b.reconcileSession(f.sessionId);
 a.setResponder(url=>url.includes('/payment_intents/')?Response.json({metadata:{order_id:f.id},currency:'usd',livemode:false,amount_received:2750}):null);
 const refund=amount=>({has_more:false,data:[{id:'re_fixture',status:'succeeded',amount,currency:'usd'}]});
 a.setSession(refund(1100));await b.reconcileRefund({payment_intent:'pi_fixture123'});await b.reconcileRefund({payment_intent:'pi_fixture123'});
 assert.equal(a.sql.prepare('SELECT SUM(amount_cents) n FROM credit_ledger').get().n,1500);
 a.setSession(refund(2750));await b.reconcileRefund({payment_intent:'pi_fixture123'});
 a.setSession(refund(1100));await b.reconcileRefund({payment_intent:'pi_fixture123'});
 assert.equal(a.sql.prepare('SELECT SUM(amount_cents) n FROM credit_ledger').get().n,0);
 assert.equal(a.sql.prepare('SELECT status FROM billing_orders').get().status,'refunded');
 a.setSession({...f.s,amount_subtotal:2500,amount_total:2750,total_details:{amount_tax:250,amount_discount:0}});await b.reconcileSession(f.sessionId);
 assert.equal(a.sql.prepare('SELECT status FROM billing_orders').get().status,'refunded');
});

test('dispute holds are bounded by unrefunded credits and terminal win cannot be reopened',async()=>{
 const a=setup({STRIPE_SECRET_KEY:'sk_test_fixture'}),f=paidFixture(a),b=a.load('lib/billing.ts');await b.reconcileSession(f.sessionId);
 const d={id:'dp_fixture',payment_intent:'pi_fixture123',livemode:false,currency:'usd',amount:2750,status:'needs_response'};
 a.setSession(d);await b.reconcileDispute(d.id);assert.equal(await b.billingHold('fixture-a'),2500);
 a.sql.prepare('INSERT INTO credit_ledger VALUES(?,?,?,?,?,?,?,?)').run('refund','fixture-a','refund',f.id,-1000,'usd','Refund',new Date().toISOString());
 assert.equal(await b.billingHold('fixture-a'),1500);
 a.setSession({...d,status:'won'});await b.reconcileDispute(d.id);assert.equal(await b.billingHold('fixture-a'),0);
 a.setSession(d);await b.reconcileDispute(d.id);assert.equal(await b.billingHold('fixture-a'),0);
});
