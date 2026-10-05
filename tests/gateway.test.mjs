import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Independent fixture. Every fetch is intercepted here; no actual network path exists.
// Runs actual API WILD TypeScript + all actual D1 migrations, without source edits.
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(root+'package.json');
const ts=require('typescript');
const sourceSnapshot=new Map();
function snapshot(path){if(!sourceSnapshot.has(path))sourceSnapshot.set(path,fs.readFileSync(root+path,'utf8'));return sourceSnapshot.get(path);}
const migrationSnapshot=fs.readdirSync(root+'drizzle').filter(f=>f.endsWith('.sql')).sort().map(f=>snapshot('drizzle/'+f));
const ready={STRIPE_SECRET_KEY:'sk_live_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',BILLING_ENABLED:'true',WEBHOOK_INGRESS_VERIFIED:'true',COMMERCE_READY:'true',GATEWAY_ENABLED:'true',GATEWAY_ACCEPTANCE_VERIFIED:'true',SUBROUTER_API_KEY:'subrouter-fixture',SUBROUTER_COMMERCIAL_USE_VERIFIED:'true',SUBROUTER_DAILY_BUDGET_MICROS:'1000000',YOU_API_KEY:'you-fixture',YOU_COMMERCIAL_USE_VERIFIED:'true',YOU_DAILY_BUDGET_MICROS:'1000000',DEEPGRAM_API_KEY:'deepgram-fixture',DEEPGRAM_COMMERCIAL_USE_VERIFIED:'true',DEEPGRAM_DAILY_BUDGET_MICROS:'1000000'};
const zero={together:0,you:0,deepgram:0};
const caps={together:1000000,you:1000000,deepgram:1000000};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};}
function fixture(extra={}){
 const sql=new DatabaseSync(':memory:');for(const migration of migrationSnapshot)sql.exec(migration);
 let clock=Date.parse('2026-09-08T15:30:00.000Z'),failBatches=0,handler=null;
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
 const bindCounts=[],calls=[];
 const db={prepare(query){let args=[];const execute=(kind)=>{const stmt=sql.prepare(query);if(kind==='first')return stmt.get(...args)||null;if(kind==='all')return{results:stmt.all(...args)};return{meta:{changes:Number(stmt.run(...args).changes)}}};return{bind(...a){args=a;bindCounts.push({expected:(query.match(/\?/g)||[]).length,actual:a.length});return this;},async first(){return execute('first');},async all(){return execute('all');},async run(){return execute('run');},execute};},async batch(statements){if(failBatches){failBatches--;throw new Error('Fixture database batch failure');}sql.exec('BEGIN');try{const results=statements.map(s=>s.execute('run'));sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB:db,SUPABASE_URL:'https://supabase.fixture',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',...ready,...extra};
 async function interceptedFetch(url,opts={}){
  const entry={url:String(url),opts};calls.push(entry);
  if(handler){const response=await handler(entry.url,opts);if(response!==undefined&&response!==null)return response;}
  if(entry.url==='https://supabase.fixture/auth/v1/user'){
   const token=opts.headers.authorization.slice(7);
   if(token==='invalid')return Response.json({error:'Invalid'},{status:401});
   return Response.json({id:token,email:token+'@example.test',email_confirmed_at:'2026-01-01',is_anonymous:false});
  }
  if(entry.url.startsWith('https://supabase.fixture/rest/v1/customer_profiles'))return Response.json([{onboarding_completed_at:'2026-01-01'}]);
  if(entry.url==='https://subrouter.ai/v1/chat/completions')return Response.json({id:'subrouter-fixture-id',model:'gpt-6-astra',usage:{prompt_tokens:100,completion_tokens:50},choices:[{message:{content:'Fixture response'}}]});
  if(entry.url==='https://ydc-index.io/v1/search')return Response.json({metadata:{search_uuid:'search-fixture-id'},results:{web:[{url:'https://example.com/source',title:'Fixture source',snippets:['Fixture evidence.']}]}});
  if(entry.url.startsWith('https://api.deepgram.com/v1/listen?'))return Response.json({metadata:{request_id:'transcribe-fixture-id',duration:1},results:{channels:[{alternatives:[{transcript:'Hello from fixture audio'}]}]}});
  if(entry.url.startsWith('https://api.deepgram.com/v1/speak?'))return new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':'audio/mpeg','dg-char-count':String(Array.from(JSON.parse(opts.body).text).length),'dg-request-id':'speak-fixture-id'}});
  throw new Error('Unmatched fake fetch: '+entry.url);
 }
 const cache={};
 function load(path){
  if(cache[path])return cache[path];
  if(path.endsWith('.json'))return JSON.parse(snapshot(path));
  const js=ts.transpileModule(snapshot(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  vm.runInNewContext(js,{module,exports:module.exports,require:n=>n==='cloudflare:workers'?{env}:n.startsWith('@/')?load(n.slice(2)+(n.endsWith('.json')?'':'.ts')):require(n),Response,Request,URL,URLSearchParams,TextDecoder,TextEncoder,Uint8Array,DataView,crypto,AbortSignal,console,Date:ClockDate,Error,SyntaxError,Set,fetch:interceptedFetch,atob,btoa},{filename:path});
  cache[path]=module.exports;return module.exports;
 }
 const owner=(user='fixture-a',mode='live')=>mode+':supabase:'+user;
 function fund(cents=100,user='fixture-a',mode='live',currency='usd'){const id=crypto.randomUUID();sql.prepare('INSERT INTO credit_ledger VALUES(?,?,?,?,?,?,?,?)').run(id,owner(user,mode),'fixture-funding:'+id,'order-'+id,cents,currency,'Fixture purchase',new ClockDate().toISOString());}
 return {sql,db,env,calls,load,owner,fund,bindCounts,now:()=>new ClockDate().toISOString(),setTime:value=>{clock=Date.parse(value)},setHandler:f=>handler=f,failBatch:()=>failBatches++,providerCalls:()=>calls.filter(c=>!c.url.startsWith('https://supabase.fixture/')&&!c.url.startsWith('https://api.stripe.com/'))};
}
function request(body={mode:'chat',messages:[{role:'user',content:'Hello'}]},key='review-request-0001',auth='fixture-a',path='/api/gateway/run',origin='https://example.test'){
 const headers={'Content-Type':'application/json','Idempotency-Key':key};if(auth)headers.Authorization='Bearer '+auth;if(origin)headers.Origin=origin;
 return new Request('https://example.test'+path,{method:'POST',headers,body:JSON.stringify(body)});
}
function get(path,auth='fixture-a'){return new Request('https://example.test'+path,{headers:{Authorization:'Bearer '+auth}});}
async function run(a,...args){return a.load('app/api/gateway/run/route.ts').POST(request(...args));}
async function key(a,{scopes=['chat'],dailyLimitDollars=1,totalLimitDollars=1,user='fixture-a'}={}){
 const response=await a.load('app/api/gateway/keys/route.ts').POST(request({name:'Review key',days:30,scopes,dailyLimitDollars,totalLimitDollars},'not-used-key-0001',user,'/api/gateway/keys'));
 assert.equal(response.status,201,await response.clone().text());
 const secret=(await response.json()).key;
 const row=a.sql.prepare('SELECT * FROM gateway_keys WHERE hash=?').get(createHash('sha256').update(secret).digest('hex'));
 assert.ok(row);assert.ok(!JSON.stringify(row).includes(secret));return{secret,row};
}
function audio(){const pcm=Buffer.alloc(32000),header=Buffer.alloc(44);header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]).toString('base64');}

test('gates reject disabled gateway and test billing before provider calls',async()=>{
 for(const extra of [{GATEWAY_ENABLED:'false'},{GATEWAY_ACCEPTANCE_VERIFIED:'false'},{SUBROUTER_COMMERCIAL_USE_VERIFIED:'false'},{STRIPE_SECRET_KEY:'sk_test_fixture'}]){
  const a=fixture(extra);a.fund(100);a.fund(100,'fixture-a','test');
  assert.equal((await run(a)).status,503);assert.equal(a.providerCalls().length,0);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM gateway_requests').get().n,0);
 }
});

test('live gateway cannot spend test, other-tenant or non-USD credit',async()=>{
 const a=fixture();a.fund(100,'fixture-a','test');a.fund(100,'fixture-b');a.fund(100,'fixture-a','live','cad');
 assert.equal((await run(a)).status,429);assert.equal(a.providerCalls().length,0);
 a.fund(1);assert.equal((await run(a)).status,200);assert.equal(a.providerCalls().length,1);
});

test('spoofed Site auth headers and cross-origin requests cannot invoke providers',async()=>{
 const a=fixture();a.fund(100);const spoof=request(undefined,undefined,null);spoof.headers.set('oai-authenticated-user-id','fixture-a');spoof.headers.set('oai-authenticated-user-email','fixture@example.test');
 assert.equal((await a.load('app/api/gateway/run/route.ts').POST(spoof)).status,401);
 assert.equal((await run(a,undefined,undefined,'fixture-a','/api/gateway/run','https://evil.test')).status,403);
 assert.equal(a.providerCalls().length,0);
});

test('atomic credit reservation admits exactly one of 32 contending requests',async()=>{
 const a=fixture();a.fund(1);const l=a.load('lib/gateway-ledger.ts');
 const results=await Promise.allSettled(Array.from({length:32},(_,i)=>l.reserveGateway({owner:a.owner(),keyId:null},'atomic-'+i,'hash-'+i,'chat','model',{...zero,together:7000},caps)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM gateway_requests').get().n,1);
 assert.equal((await l.gatewayBalance(a.owner())).available,3000);
});

test('concurrent duplicate dispatch calls provider once and replay never charges again',async()=>{
 const a=fixture();a.fund();const entered=deferred(),release=deferred();
 a.setHandler(async url=>{if(url.includes('subrouter.ai')){entered.resolve();return await release.promise;}});
 const first=run(a);await entered.promise;
 assert.equal((await run(a)).status,409);
 release.resolve(Response.json({id:'one-paid-call',usage:{prompt_tokens:100,completion_tokens:50},choices:[{message:{content:'Only one'}}]}));
 assert.equal((await first).status,200);const replay=await run(a);assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
 assert.equal(a.providerCalls().length,1);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM gateway_outbox').get().n,1);assert.equal(a.sql.prepare('SELECT cost_micros FROM gateway_requests').get().cost_micros,175);
 assert.equal((await run(a,{mode:'chat',messages:[{role:'user',content:'Changed body'}]})).status,409);assert.equal(a.providerCalls().length,1);
});

test('key scopes, expiry, revocation and mode restrict execution and replay',async()=>{
 const a=fixture();a.fund();const k=await key(a);
 assert.equal((await run(a,{mode:'code',messages:[{role:'user',content:'Code please'}]},'code-request-00001',k.secret)).status,403);
 assert.equal((await run(a,undefined,undefined,k.secret)).status,200);
 a.sql.prepare('UPDATE gateway_keys SET revoked_at=? WHERE id=?').run(a.now(),k.row.id);
 assert.equal((await run(a,undefined,undefined,k.secret)).status,401);
 a.sql.prepare('UPDATE gateway_keys SET revoked_at=NULL,expires_at=? WHERE id=?').run('2020-01-01',k.row.id);
 assert.equal((await run(a,undefined,'expired-request-01',k.secret)).status,401);
 const t=await key(a);a.sql.prepare('UPDATE gateway_keys SET user_id=? WHERE id=?').run(a.owner('fixture-a','test'),t.row.id);
 assert.equal((await run(a,undefined,'test-owner-key-001',t.secret)).status,401);
 assert.equal(a.providerCalls().length,1);
});

test('per-key daily and lifetime caps atomically bound reservations',async()=>{
 for(const setting of ['daily_limit_micros','total_limit_micros']){
  const a=fixture();a.fund();const k=await key(a);a.sql.prepare('UPDATE gateway_keys SET '+setting+'=100 WHERE id=?').run(k.row.id);
  assert.equal((await run(a,undefined,undefined,k.secret)).status,429);assert.equal(a.providerCalls().length,0);
  const l=a.load('lib/gateway-ledger.ts');const first=await l.reserveGateway({owner:a.owner(),keyId:k.row.id},'direct-key-request','hash','chat','model',{...zero,together:75},caps);assert.ok(first.fresh);
  await assert.rejects(l.reserveGateway({owner:a.owner(),keyId:k.row.id},'direct-key-second','hash2','chat','model',{...zero,together:75},caps),e=>e.status===429);
 }
});

test('timeouts retain the maximum hold and duplicate requests do not retry providers',async()=>{
 const a=fixture();a.fund();a.setHandler(url=>{if(url.includes('subrouter.ai'))throw new Error('Fixture timeout');});
 const response=await run(a);assert.equal(response.status,503);assert.equal((await response.json()).status,'uncertain');
 let row=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(row.state,'uncertain');assert.equal(row.cost_micros,0);
 assert.equal((await a.load('lib/gateway-ledger.ts').gatewayBalance(a.owner())).reserved,row.reserved_micros);
 a.setTime('2026-09-10T16:00:00Z');await a.load('lib/gateway-ledger.ts').maintainGateway();
 row=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(row.state,'uncertain');assert.equal((await run(a)).status,409);assert.equal(a.providerCalls().length,1);
});

test('late valid settlement clears an uncertain hold once and keeps original rate version',async()=>{
 const a=fixture();a.fund();const l=a.load('lib/gateway-ledger.ts'),r=await l.reserveGateway({owner:a.owner(),keyId:null},'late-settlement-1','hash','chat','model',{...zero,together:100},caps);
 r.record.rate_version='fixture-original-rate';a.sql.prepare('UPDATE gateway_requests SET rate_version=? WHERE id=?').run(r.record.rate_version,r.record.id);
 await l.claimGateway(r.record.id);await l.uncertainGateway(r.record.id,zero,{});
 assert.equal(await l.finishGateway(r.record,{...zero,together:50},{text:'Original'},{}),50);
 await assert.rejects(()=>l.finishGateway(r.record,{...zero,together:20},{text:'Overwrite'},{}),/Settlement did not commit/);
 const row=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(row.state,'succeeded');assert.equal(JSON.parse(row.result_json).text,'Original');
 const outbox=JSON.parse(a.sql.prepare('SELECT payload FROM gateway_outbox').get().payload);assert.equal(outbox.properties.rate_version,'fixture-original-rate');assert.equal(outbox.properties.retail_micros,50);
 assert.equal((await l.gatewayBalance(a.owner())).reserved,0);
});

test('terminal rejection releases customer hold and charges zero',async()=>{
 const a=fixture();a.fund();a.setHandler(url=>url.includes('subrouter.ai')?Response.json({error:'Fixture reject'},{status:400}):undefined);
 const response=await run(a);assert.equal(response.status,502);assert.equal((await response.json()).costMicros,0);
 const row=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(row.state,'failed');assert.equal(row.cost_micros,0);
 const b=await a.load('lib/gateway-ledger.ts').gatewayBalance(a.owner());assert.equal(b.available,1000000);assert.equal(b.reserved,0);assert.equal(b.spent,0);
 assert.equal((await run(a)).status,502);assert.equal(a.providerCalls().length,1);
});

test('failed research is free to customer but first-leg provider cost still consumes operator cap',async()=>{
 const a=fixture({YOU_DAILY_BUDGET_MICROS:'5000'});a.fund();a.setHandler(url=>url.includes('subrouter.ai')?Response.json({error:'Fixture reject'},{status:400}):undefined);
 const body={mode:'research',messages:[{role:'user',content:'Research this'}]};
 assert.equal((await run(a,body)).status,502);const row=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(row.you_cost,5000);assert.equal(row.cost_micros,0);assert.equal(row.state,'failed');
 assert.equal((await run(a,body,'research-next-0001')).status,429);assert.equal(a.providerCalls().length,2);
});

test('active provider progress counts reservation once and unrelated depleted provider does not block chat',async()=>{
 const a=fixture();a.fund(100);const l=a.load('lib/gateway-ledger.ts');
 const r=await l.reserveGateway({owner:a.owner(),keyId:null},'progress-first-01','hash','research','model',{together:100,you:5000,deepgram:0},{together:200,you:5000,deepgram:0});
 await l.claimGateway(r.record.id);await l.progressGateway(r.record.id,{together:60,you:5000,deepgram:0},{});
 const next=await l.reserveGateway({owner:a.owner(),keyId:null},'progress-second-1','hash2','chat','model',{together:100,you:0,deepgram:0},{together:200,you:0,deepgram:0});assert.ok(next.fresh);
});

test('overnight completion remains charged against todays customer and provider caps',async()=>{
 for(const cap of ['customer','provider']){
  const a=fixture();a.fund();const l=a.load('lib/gateway-ledger.ts');a.setTime('2026-09-07T23:59:00Z');
  const r=await l.reserveGateway({owner:a.owner(),keyId:null},'overnight-first1','hash','chat','model',{...zero,together:100},caps);await l.claimGateway(r.record.id);
  a.setTime('2026-09-08T00:01:00Z');await l.finishGateway(r.record,{...zero,together:100},{ok:true},{});
  if(cap==='customer')a.sql.prepare('UPDATE gateway_accounts SET daily_limit_micros=150 WHERE user_id=?').run(a.owner());
  await assert.rejects(l.reserveGateway({owner:a.owner(),keyId:null},'overnight-second','hash2','chat','model',{...zero,together:100},{...caps,together:cap==='provider'?150:1000000}),e=>e.status===429);
 }
});

test('negative/nonfinite reservations fail and individual provider overruns trip pricing fault',async()=>{
 const a=fixture();a.fund();const l=a.load('lib/gateway-ledger.ts');
 for(const n of [-1,NaN,Infinity,1.5])await assert.rejects(l.reserveGateway({owner:a.owner(),keyId:null},'invalid-'+String(n),'hash','chat','model',{together:n,you:200,deepgram:0},caps),e=>e.status===400);
 const r=await l.reserveGateway({owner:a.owner(),keyId:null},'pricing-bound-001','hash','research','model',{together:100,you:100,deepgram:0},caps);await l.claimGateway(r.record.id);await l.finishGateway(r.record,{together:150,you:0,deepgram:0},{ok:true},{});
 assert.equal(a.sql.prepare('SELECT error_code FROM gateway_requests').get().error_code,'pricing_bound_exceeded');
 await assert.rejects(l.reserveGateway({owner:a.owner(),keyId:null},'after-price-fault','hash2','chat','model',{...zero,together:1},caps),e=>e.status===429);
});

test('failed settlement batch preserves reservation, measured cost and zero outbox rows',async()=>{
 const a=fixture();a.fund();a.setHandler(url=>{if(url.includes('subrouter.ai'))a.failBatch()});const response=await run(a);assert.equal(response.status,503);
 const row=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(row.state,'uncertain');assert.equal(row.cost_micros,0);assert.equal(row.together_cost,175);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM gateway_outbox').get().n,0);
 assert.equal((await run(a)).status,409);assert.equal(a.providerCalls().length,1);
});

test('maintenance releases only never-dispatched work and never revives expired claims',async()=>{
 const a=fixture();a.fund();const l=a.load('lib/gateway-ledger.ts');
 const unstarted=await l.reserveGateway({owner:a.owner(),keyId:null},'expire-unstarted','hash','chat','model',{...zero,together:100},caps);
 const started=await l.reserveGateway({owner:a.owner(),keyId:null},'expire-started-1','hash2','chat','model',{...zero,together:100},caps);await l.claimGateway(started.record.id);
 a.setTime('2026-09-08T16:00:00Z');await l.maintainGateway();
 assert.equal(a.sql.prepare('SELECT state FROM gateway_requests WHERE id=?').get(unstarted.record.id).state,'cancelled');assert.equal(a.sql.prepare('SELECT state FROM gateway_requests WHERE id=?').get(started.record.id).state,'uncertain');
 assert.equal(await l.claimGateway(unstarted.record.id),null);assert.equal((await l.gatewayBalance(a.owner())).reserved,100);
});

test('refund-after-spend preserves usage, reverses funding once and prevents new consumption',async()=>{
 const a=fixture(),owner=a.owner(),now=a.now(),id='fixture-order',sessionId='cs_live_fixturepayment';
 a.sql.prepare('INSERT INTO billing_orders(id,user_id,request_id,pack,amount_cents,currency,session_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,owner,'fixture-order-request','starter',2500,'usd',sessionId,'checkout',now);
 let refunded=false;
 a.setHandler(url=>{
  if(url.includes('/checkout/sessions/'))return Response.json({id:sessionId,mode:'payment',status:'complete',payment_status:'paid',client_reference_id:id,metadata:{order_id:id},amount_total:2500,currency:'usd',livemode:true,payment_intent:'pi_fixturepayment'});
  if(url.includes('/payment_intents/'))return Response.json({id:'pi_fixturepayment',livemode:true,currency:'usd',metadata:{order_id:id},amount_received:2500});
  if(url.includes('/refunds?'))return Response.json({has_more:false,data:refunded?[{id:'re_fixture',status:'succeeded',currency:'usd',amount:2500}]:[]});
 });
 const billing=a.load('lib/billing.ts');await billing.reconcileSession(sessionId);await billing.reconcileSession(sessionId);
 assert.equal((await run(a)).status,200);assert.equal(a.sql.prepare('SELECT status FROM billing_orders').get().status,'paid');
 refunded=true;await billing.reconcileRefund({payment_intent:'pi_fixturepayment'});await billing.reconcileRefund({payment_intent:'pi_fixturepayment'});
 const b=await a.load('lib/gateway-ledger.ts').gatewayBalance(owner);assert.equal(b.funded,0);assert.equal(b.spent,175);assert.equal(b.shortfall,175);assert.equal(b.available,0);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,2);assert.equal(a.sql.prepare('SELECT status FROM billing_orders').get().status,'refunded');
 assert.equal((await run(a,undefined,'after-refund-0001')).status,429);assert.equal(a.providerCalls().length,1);
});

test('voice workflow reserves and measures Deepgram + Together with recoverable audio',async()=>{
 const a=fixture();a.fund();const response=await run(a,{mode:'voice',audioBase64:audio(),max_tokens:64});assert.equal(response.status,200,await response.clone().text());
 const result=await response.json();assert.equal(result.transcript,'Hello from fixture audio');assert.ok(result.audioBase64);
 assert.equal(a.providerCalls().length,3);assert.equal(a.providerCalls().filter(c=>c.url.includes('deepgram.com')).length,2);
 const row=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(row.state,'succeeded');assert.equal(row.cost_micros,row.together_cost+row.deepgram_cost);assert.equal(row.you_cost,0);assert.ok(!row.result_json.includes('audioBase64'));
});

test('scoped keys cannot replay another keys request through POST after GET denies it',async()=>{
 const a=fixture();a.fund();const first=await key(a),second=await key(a);
 const result=await run(a,undefined,'same-owner-shared-key',first.secret);assert.equal(result.status,200);const id=(await result.json()).id;
 assert.equal((await a.load('app/api/gateway/route.ts').GET(get('/api/gateway?id='+id,second.secret))).status,404);
 const replay=await run(a,undefined,'same-owner-shared-key',second.secret);
 assert.ok([403,404,409].includes(replay.status),'POST replay returned '+replay.status+' for another scoped key');
});

test('all exercised SQL bind counts match their parameters',async()=>{
 const a=fixture();a.fund();const k=await key(a);await run(a,undefined,undefined,k.secret);await a.load('app/api/gateway/route.ts').GET(get('/api/gateway',k.secret));
 assert.deepEqual(a.bindCounts.filter(c=>c.expected!==c.actual),[]);
});



test('ambiguous WAV layouts and malformed tails are rejected before dispatch',async()=>{
 const a=fixture(),provider=a.load('lib/gateway-providers.ts'),valid=Buffer.from(audio(),'base64');
 const duplicate=Buffer.concat([valid,valid.subarray(12,36)]);duplicate.writeUInt32LE(duplicate.length-8,4);
 assert.throws(()=>provider.wavAudio(duplicate.toString('base64')),e=>e.status===400);
 const trailing=Buffer.concat([valid,Buffer.from([0,0])]);trailing.writeUInt32LE(trailing.length-8,4);
 assert.throws(()=>provider.wavAudio(trailing.toString('base64')),e=>e.status===400);
 const rate=Buffer.from(valid);rate.writeUInt32LE(8000,24);rate.writeUInt32LE(16000,28);
 assert.throws(()=>provider.wavAudio(rate.toString('base64')),e=>e.status===400);
 assert.equal(provider.wavAudio(audio()).seconds,1);assert.equal(a.providerCalls().length,0);
});

test('voice replay and owner recovery return the original audio with no extra charge',async()=>{
 const a=fixture();a.fund();const body={mode:'voice',audioBase64:audio(),messages:[],max_tokens:100};
 const original=await (await run(a,body,'audio-recovery-001')).json();
 const replay=await (await run(a,body,'audio-recovery-001')).json();
 assert.equal(replay.audioBase64,original.audioBase64);assert.equal(replay.replayed,true);assert.equal(a.providerCalls().length,3);
 const recovered=await (await a.load('app/api/gateway/route.ts').GET(get('/api/gateway?id='+original.id))).json();assert.equal(recovered.result.audioBase64,original.audioBase64);
 assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM gateway_outbox').get().n,1);assert.ok(a.sql.prepare('SELECT COUNT(*) n FROM gateway_audio').get().n>0);
 a.setTime('2026-09-16T16:00:00Z');await a.load('lib/gateway-ledger.ts').maintainGateway();
 assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM gateway_audio').get().n,0);
 assert.equal((await run(a,body,'audio-recovery-001')).status,409);assert.equal(a.providerCalls().length,3);
});

test('known provider receipt survives missing usage and reserves customer funds',async()=>{
 const a=fixture();a.fund();a.setHandler(url=>url.includes('subrouter.ai')?Response.json({id:'known-receipt-001',usage:null,choices:[{message:{content:'Result'}}]}):undefined);
 const response=await run(a);assert.equal(response.status,503);const row=a.sql.prepare('SELECT * FROM gateway_requests').get();
 const receipt=JSON.parse(row.usage_json)[0];assert.equal(receipt.requestId,'known-receipt-001');assert.ok(receipt.attemptId.includes(row.id));assert.equal(receipt.status,'receipt_received');assert.equal(row.cost_micros,0);assert.equal(row.state,'uncertain');
});

test('research context has a UTF-8 bound and ignores unsafe source links',async()=>{
 const a=fixture();a.setHandler(url=>url.includes('ydc-index.io')?Response.json({metadata:{search_uuid:'unicode-search'},results:{web:[{url:'javascript:alert(1)',title:'Ignore',snippets:['no']},...Array.from({length:5},()=>({url:'https://example.com/evidence',title:'漢'.repeat(200),snippets:['漢'.repeat(4000)]}))]}}):undefined);
 const result=await a.load('lib/gateway-providers.ts').searchEvidence('test');assert.equal(result.sources.length,5);
 assert.ok(new TextEncoder().encode(result.sources.map(s=>s.title+s.snippet).join('')).length<=11000);
 assert.ok(result.sources.every(s=>s.url.startsWith('https://')));
});

test('compatibility endpoint preserves truncated finish reason and exact model routing',async()=>{
 const a=fixture();a.fund();a.setHandler(url=>url.includes('subrouter.ai')?Response.json({id:'length-example',usage:{prompt_tokens:10,completion_tokens:20},choices:[{message:{content:'Partial code'},finish_reason:'length'}]}):undefined);
 const route=a.load('app/v1/chat/completions/route.ts');const response=await route.POST(request({model:'apiwild/code',messages:[{role:'user',content:'Write code'}],max_tokens:20},'openai-compat-001'));
 assert.equal(response.status,200);const result=await response.json();assert.equal(result.choices[0].finish_reason,'length');assert.equal(JSON.parse(a.providerCalls()[0].opts.body).model,'deepseek-v4-flash');
 assert.equal((await route.POST(request({model:'unavailable/model',messages:[{role:'user',content:'Hello'}]},'invalid-model-001'))).status,400);
});

test('operator evidence resolves unrecoverable holds once without customer charges',async()=>{
 const a=fixture({GATEWAY_OPERATIONS_SECRET:'operations-fixture'});a.fund();a.setHandler(url=>{if(url.includes('subrouter.ai'))throw Error('Lost response')});await run(a);
 const row=a.sql.prepare('SELECT * FROM gateway_requests').get(),ops=a.load('app/api/gateway/operations/route.ts');
 const body={action:'resolve_failed',id:row.id,expectedUpdatedAt:row.updated_at,providerCosts:{together:25,you:0,deepgram:0},evidence:[{provider:'subrouter',reference:'provider-invoice-fixture',finding:'The provider confirms this attempt consumed 25 microdollars.'}],operatorVerified:true};
 assert.equal((await ops.POST(request(body,'unused-idempotency','wrong'))).status,401);
 assert.equal((await ops.POST(request(body,'unused-idempotency','operations-fixture'))).status,200);
 assert.equal((await ops.POST(request(body,'unused-idempotency','operations-fixture'))).status,409);
 const final=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(final.state,'failed');assert.equal(final.together_cost,25);assert.equal(final.cost_micros,0);assert.equal((await a.load('lib/gateway-ledger.ts').gatewayBalance(a.owner())).reserved,0);
 assert.ok(JSON.parse(final.usage_json).some(e=>e.kind==='operator_resolution'));
});

test('outbox exports require operator authentication and a durable receipt acknowledgement',async()=>{
 const a=fixture({GATEWAY_OPERATIONS_SECRET:'operations-fixture'});a.fund();await run(a);const ops=a.load('app/api/gateway/operations/route.ts');
 assert.equal((await ops.GET(get('/api/gateway/operations'))).status,401);
 const data=await (await ops.GET(get('/api/gateway/operations','operations-fixture'))).json();assert.equal(data.outbox.length,1);
 const body={action:'acknowledge_export',ids:[data.outbox[0].id],destinationReceipt:'external-dedup-receipt-001'};
 assert.equal((await ops.POST(request(body,'unused-idempotency','operations-fixture'))).status,200);
 const row=a.sql.prepare('SELECT * FROM gateway_outbox').get();assert.equal(row.state,'exported');assert.equal(row.export_receipt,body.destinationReceipt);
});

test('billing available balance subtracts settled usage and ambiguous reservations',async()=>{
 const a=fixture();a.fund();await run(a);a.setHandler(url=>{if(url.includes('subrouter.ai'))throw Error('Lost')});await run(a,undefined,'billing-held-0001');
 const usage=await a.load('lib/gateway-ledger.ts').gatewayBalance(a.owner());
 const response=await a.load('app/api/billing/route.ts').GET(get('/api/billing'));assert.equal(response.status,200);const bill=await response.json();
 assert.equal(bill.balance.cents,100);assert.equal(bill.availableCents,usage.available/10000);assert.equal(bill.usage.spent,175);assert.ok(bill.usage.reserved>0);
});


test('receipt-free interrupted requests resolve and concurrent stale operators cannot overwrite audit',async()=>{
 const a=fixture({GATEWAY_OPERATIONS_SECRET:'operations-fixture'});a.fund();const l=a.load('lib/gateway-ledger.ts');
 const r=await l.reserveGateway({owner:a.owner(),keyId:null},'no-receipt-operator','hash','chat','model',{...zero,together:100},caps);await l.claimGateway(r.record.id);
 a.setTime('2026-09-08T15:40:00Z');await l.maintainGateway();const row=a.sql.prepare('SELECT * FROM gateway_requests').get();assert.equal(row.usage_json,'{}');
 const ops=a.load('app/api/gateway/operations/route.ts'),body={action:'resolve_failed',id:row.id,expectedUpdatedAt:row.updated_at,providerCosts:{together:10,you:0,deepgram:0},evidence:[{provider:'together',reference:'fixture-receipt-001',finding:'Verified no recoverable output; supplier cost reconciled.'}],operatorVerified:true};
 const statuses=await Promise.all([ops.POST(request(body,'operator-race-001','operations-fixture')),ops.POST(request({...body,providerCosts:{...body.providerCosts,together:20}},'operator-race-002','operations-fixture'))]);
 assert.deepEqual(statuses.map(r=>r.status).sort(),[200,409]);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM gateway_outbox').get().n,1);assert.equal(a.sql.prepare('SELECT cost_micros FROM gateway_requests').get().cost_micros,0);
});

test('export acknowledgement counts actual transitions and preserves original delivery receipt',async()=>{
 const a=fixture({GATEWAY_OPERATIONS_SECRET:'operations-fixture'});a.fund();await run(a);const ops=a.load('app/api/gateway/operations/route.ts'),id=a.sql.prepare('SELECT id FROM gateway_outbox').get().id;
 const body={action:'acknowledge_export',ids:[id,crypto.randomUUID()],destinationReceipt:'verified-destination-receipt'};
 const first=await (await ops.POST(request(body,'export-count-001','operations-fixture'))).json();assert.equal(first.acknowledged,1);assert.equal(first.requested,2);
 const repeat=await (await ops.POST(request({...body,destinationReceipt:'different-receipt'},'export-count-002','operations-fixture'))).json();assert.equal(repeat.acknowledged,0);assert.equal(a.sql.prepare('SELECT export_receipt FROM gateway_outbox').get().export_receipt,body.destinationReceipt);
});
