import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './lifecycle.test.mjs';
const secret='fixture-bridge-secret-32-characters-long',owner='live:supabase:fixture';
const reserve={action:'reserve',requestKey:'request-fixture-0001',payloadHash:'a'.repeat(64),model:'openai/gpt-6-luna',maximumCredits:600};
function fixture(){
 const f=setup({STRIPE_SECRET_KEY:'rk_live_fixture',AARO_BRIDGE_KEY:secret,AARO_USAGE_ENABLED:'true',AARO_TARIFF_VERSION:'aaro-token-units-2026-09-27.draft-1'}),now=Math.floor(Date.now()/1000);
 f.sql.prepare('INSERT INTO aaro_checkouts(id,user_id,active_owner,plan_id,subscription_id,status,created_at) VALUES(?,?,?,?,?,?,?)').run('order_fixture',owner,owner,'global-starter','sub_fixture','active',new Date().toISOString());
 f.sql.prepare('INSERT INTO aaro_credit_periods VALUES(?,?,?,?,?,?,?,?)').run('in_fixture',owner,'sub_fixture','global-starter',1000,now-60,now+3600,new Date().toISOString());
 const route=f.load('app/api/aaro/usage/route.ts');
 const request=(body=reserve,{key=secret,token='fixture',raw,headers={}}={})=>new Request('https://apiwild.com/api/aaro/usage',{method:'POST',headers:{'content-type':'application/json',...(key?{'x-aaro-bridge':key}:{}),...(token?{authorization:'Bearer '+token}:{}),...headers},body:raw??JSON.stringify(body)});
 return {...f,request,post:(body=reserve,options)=>route.POST(request(body,options))};
}

test('settlement receipt survives customer session expiry and remains bound to its reservation',async()=>{
 const f=fixture(),{id,receipt}=await(await f.post()).json();
 f.setResponder(url=>url.endsWith('/auth/v1/user')?Response.json({error:'expired'},{status:401}):null);
 assert.equal((await f.post({action:'settle',id,receipt,inputTokens:20,outputTokens:30},{token:''})).status,200);
 assert.equal(f.sql.prepare('SELECT actual_credits FROM aaro_usage_requests WHERE id=?').get(id).actual_credits,140);
 assert.equal((await f.post({action:'settle',id,receipt:{...receipt,owner:'live:supabase:victim'},inputTokens:1,outputTokens:1},{token:''})).status,401);
 assert.equal((await f.post({action:'uncertain',id:'other-id',receipt},{token:''})).status,401);
 assert.equal((await f.post({action:'uncertain',id,receipt:{...receipt,expires:1}},{token:''})).status,401);
 assert.equal((await f.post({action:'uncertain',id,receipt},{key:'',token:''})).status,403);
});

test('confirmed provider rejection releases once; ambiguous failures cannot use that path',async()=>{
 for(const providerStatus of [402,429]){
  const f=fixture(),{id,receipt}=await(await f.post()).json();
  assert.equal((await f.post({action:'failed',id,receipt,providerStatus},{token:''})).status,200);
  assert.equal((await f.post({action:'failed',id,receipt,providerStatus},{token:''})).status,200);
  const usage=await f.load('lib/aaro-usage.ts').aaroUsageTotals(owner);assert.equal(usage.available,1000);assert.equal(usage.reserved,0);
 }
 const f=fixture(),{id,receipt}=await(await f.post()).json();
 assert.equal((await f.post({action:'failed',id,receipt,providerStatus:504})).status,400);
 assert.equal(f.sql.prepare('SELECT state FROM aaro_usage_requests WHERE id=?').get(id).state,'executing');
});
test('AARO bridge requires server secret before any user verification or ledger mutation',async()=>{
 const f=fixture();
 for(const key of ['',secret+'x',secret.slice(1),'x'.repeat(secret.length)])assert.equal((await f.post(reserve,{key})).status,403);
 assert.equal(f.calls.length,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_usage_requests').get().n,0);
 f.env.AARO_BRIDGE_KEY='';assert.equal((await f.post()).status,503);
 f.env.AARO_BRIDGE_KEY='too-short';assert.equal((await f.post()).status,503);
});
test('AARO bridge rejects forged Sites identity, invalid and unconfirmed customer tokens',async()=>{
 const f=fixture();assert.equal((await f.post(reserve,{token:'',headers:{'oai-authenticated-user-id':'fixture'}})).status,401);
 f.setResponder(url=>url.endsWith('/auth/v1/user')?Response.json({error:'invalid'},{status:401}):null);assert.equal((await f.post()).status,401);
 f.setResponder(url=>url.endsWith('/auth/v1/user')?Response.json({id:'fixture',email:'fixture@example.test'}):null);assert.equal((await f.post()).status,403);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_usage_requests').get().n,0);
});
test('AARO bridge ignores submitted owner and claimed credit values; settles only measured tariff',async()=>{
 const f=fixture(),response=await f.post({...reserve,owner:'live:supabase:victim',user_id:'live:supabase:victim',credits:1});assert.equal(response.status,200);const {id}=await response.json();
 assert.equal(f.sql.prepare('SELECT user_id FROM aaro_usage_requests WHERE id=?').get(id).user_id,owner);
 const result=await f.post({action:'settle',id,inputTokens:20,outputTokens:30,actualCredits:0,owner:'live:supabase:victim'});assert.equal(result.status,200);assert.equal((await result.json()).actual_credits,140);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,0);
});
test('AARO bridge cannot claim or settle a different customer reservation',async()=>{
 const f=fixture(),{id}=await(await f.post()).json();
 assert.equal((await f.post({action:'settle',id,inputTokens:1,outputTokens:1},{token:'another-user'})).status,404);
 assert.equal((await f.post({action:'uncertain',id},{token:'another-user'})).status,404);
 assert.equal(f.sql.prepare('SELECT state FROM aaro_usage_requests WHERE id=?').get(id).state,'executing');
});
test('AARO bridge duplicate requests never dispatch twice and changed payload keys reject',async()=>{
 const f=fixture(),results=await Promise.all([f.post(),f.post()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_usage_requests').get().n,1);
 assert.equal((await f.post({...reserve,payloadHash:'b'.repeat(64)})).status,409);
 assert.equal((await f.post({...reserve,maximumCredits:500})).status,409);
});
test('AARO bridge validates allowlisted model, bounds and input shapes before ledger mutation',async()=>{
 const f=fixture();
 for(const patch of [{model:'attacker/route'},{maximumCredits:0},{maximumCredits:-1},{maximumCredits:1.1},{maximumCredits:1000001},{requestKey:'x'},{payloadHash:'bad'},{requestKey:['request-fixture-0001']},{payloadHash:['a'.repeat(64)]}])assert.equal((await f.post({...reserve,...patch})).status,400,JSON.stringify(patch));
 for(const body of [null,[],true,'reserve'])assert.equal((await f.post(body)).status,400,JSON.stringify(body));
 assert.equal((await f.post(undefined,{raw:'{invalid'})).status,400);
 assert.equal((await f.post({...reserve,padding:'x'.repeat(5000)})).status,413);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_usage_requests').get().n,0);
});
test('AARO bridge rejects missing usage and over-reservation settlement, retaining uncertain holds',async()=>{
 const f=fixture(),{id}=await(await f.post()).json();
 assert.equal((await f.post({action:'settle',id})).status,400);
 assert.equal((await f.post({action:'settle',id,inputTokens:1,outputTokens:150})).status,409);
 assert.equal((await f.post({action:'settle',id,inputTokens:-1,outputTokens:1})).status,400);
 assert.equal((await f.post({action:'uncertain',id})).status,200);
 assert.equal(f.sql.prepare('SELECT state FROM aaro_usage_requests WHERE id=?').get(id).state,'uncertain');
 assert.equal((await f.post({...reserve,requestKey:'request-fixture-0002'})).status,402);
});
test('AARO bridge gate stays closed with draft tariff unapproved while existing settlement can complete',async()=>{
 const f=fixture(),{id}=await(await f.post()).json();f.env.AARO_USAGE_ENABLED='false';
 assert.equal((await f.post({...reserve,requestKey:'request-fixture-0002'})).status,503);
 assert.equal((await f.post({action:'settle',id,inputTokens:20,outputTokens:30})).status,200);
 f.env.AARO_USAGE_ENABLED='true';f.env.AARO_TARIFF_VERSION='other';assert.equal((await f.post({...reserve,requestKey:'request-fixture-0002'})).status,503);
});
test('AARO billing status returns real owner-scoped available/reserved/spent totals',async()=>{
 const f=fixture(),{id}=await(await f.post()).json(),status=f.load('lib/aaro-billing.ts');let current=await status.aaroStatus(owner);
 assert.equal(current.usage.available,400);assert.equal(current.usage.reserved,600);assert.equal(current.usage.spent,0);assert.equal(current.usageEnabled,true);
 await f.post({action:'settle',id,inputTokens:20,outputTokens:30});current=await status.aaroStatus(owner);assert.equal(current.usage.available,860);assert.equal(current.usage.spent,140);
 assert.equal((await status.aaroStatus('live:supabase:another-user')).usage.available,0);
});
