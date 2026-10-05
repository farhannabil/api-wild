// Real loopback HTTP fixture only. Synthetic customer/units/receipts; no external calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createPreparationServer} from '../preparation-server.mjs';
import {createAaroUsageBridge,AARO_PROTOCOL} from '../runtime/aaro-usage-bridge.mjs';
import {createAaroUsageIngress} from '../runtime/aaro-usage-ingress.mjs';
import {createStripeWebhookIngress} from '../runtime/stripe-webhook-ingress.mjs';
const USER='11111111-1111-4111-8111-111111111111',owner='test:supabase:'+USER,key='k'.repeat(32);
const binding=()=>({protocol:AARO_PROTOCOL,product:'aaro',owner,mode:'test',keyReference:'fixture-key',tariffVersion:'fixture-NOT-A-PRICE',acceptanceReceiptSHA256:'a'.repeat(64),model:'fixture/model',requestKey:randomUUID(),payloadHash:'b'.repeat(64),maximumInputTokens:100,maximumOutputTokens:20,totalCapNativeCnyMicros:50000000});
const body=()=>JSON.stringify({action:'reserve',...binding()});
function fixture({verify,deadlineMilliseconds=1000,maxConcurrent=4}={}){
  const seen={verify:[],reserve:0};
  const rpc={verifyCustomer:async(token,signal)=>{seen.verify.push({token,signal});return verify?verify(token,signal):{id:USER};},reserve:async(who,b,signal)=>{signal.throwIfAborted();seen.reserve++;return {fresh:true,record:{id:randomUUID(),owner:who,binding:b,key_reference:b.keyReference,billing_mode:b.mode,request_key:b.requestKey,state:'reserved',maximum_credits:180,maximum_native_cny_micros:120,actual_credits:0,actual_native_cny_micros:0,observed_native_cny_micros:0,admission_receipt_sha256:'c'.repeat(64),expires_at:new Date(Date.now()+120000).toISOString()}};},read:async()=>{},claim:async()=>{},settle:async()=>{},uncertain:async()=>{}};
  const bridge=createAaroUsageBridge({enabled:true,financialAcceptanceVerified:true,providerAcceptanceVerified:true,webhookIngressVerified:true,billingMode:'test',keyReference:'fixture-key',tariffVersion:'fixture-NOT-A-PRICE',acceptanceReceiptSHA256:'a'.repeat(64),bridgeKey:key,rpc,reconcileSupplierDebit:async()=>{throw Error('no supplier dispatch in ingress fixture');}});
  return {ingress:createAaroUsageIngress({bridge,deadlineMilliseconds,maxConcurrent}),seen};
}
async function withServer(options,work){
  const server=createPreparationServer(options);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{await work(server.address().port);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
function invoke(port,{path='/api/aaro/usage',method='POST',headers={},raw=body(),chunked=false,stall=false}={}){
  return new Promise((resolve,reject)=>{
    const actual={host:'apiwild.com',origin:'https://apiwild.com','x-forwarded-proto':'https','content-type':'application/json',authorization:'Bearer fixture-customer-token','x-aaro-bridge':key,...(!chunked&&!stall&&method==='POST'?{'content-length':Buffer.byteLength(raw)}:{}),...headers};
    for(const [name,value] of Object.entries(actual))if(value===null||value===undefined)delete actual[name];
    const request=httpRequest({host:'127.0.0.1',port,path,method,headers:actual,agent:false},reply=>{const chunks=[];reply.on('data',part=>chunks.push(part));reply.once('end',()=>resolve({status:reply.statusCode,headers:reply.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));reply.once('error',reject);});
    request.once('error',reject);request.setTimeout(2500,()=>request.destroy(Error('Loopback fixture timeout')));
    if(method==='POST'){if(chunked){request.write(raw.slice(0,2000));request.write(raw.slice(2000));}else request.write(raw);}if(!stall)request.end();
  });
}

test('default existing server and disabled injection stay closed; arbitrary handler objects are rejected',async()=>{
  assert.throws(()=>createPreparationServer({aaroUsageIngress:{handle(){}}}),/Invalid AARO/);assert.throws(()=>createAaroUsageIngress({bridge:async()=>new Response('fake')}));
  for(const config of [{},{aaroUsageIngress:createAaroUsageIngress({bridge:createAaroUsageBridge()})}])await withServer(config,async port=>{const result=await invoke(port);assert.equal(result.status,503);assert.equal(config.aaroUsageIngress?result.body.code:result.body.phase,config.aaroUsageIngress?'AARO_FINANCE_UNACCEPTED':'railway-preparation');});
});
test('explicit injected bridge handles only exact canonical route and preserves customer/bridge headers and response',async()=>{
  const f=fixture();await withServer({aaroUsageIngress:f.ingress},async port=>{
    const result=await invoke(port);assert.equal(result.status,200);assert.equal(result.body.reserved,true);assert.equal(result.body.protocol,AARO_PROTOCOL);assert.equal(result.body.owner,owner);assert.equal(result.body.maximumNativeCnyMicros,120);assert.equal(result.headers['cache-control'],'private, no-store');assert.equal(result.headers['x-content-type-options'],'nosniff');assert.match(result.headers['content-type'],/^application\/json/);assert.equal(result.headers['set-cookie'],undefined);
    assert.equal(f.seen.verify[0].token,'fixture-customer-token');assert.equal(f.seen.reserve,1);assert.ok(!JSON.stringify(result.body).includes(key));
    for(const path of ['/api/aaro/usage?x=1','/%61pi/aaro/usage','/api/aaro/usage/','/api/aaro/billing','/api/billing/checkout','/v1/chat/completions'])assert.equal((await invoke(port,{path})).status,503);
    assert.equal(f.seen.reserve,1);
  });
});
test('Host/Origin/forwarded identity is never laundered into canonical authority',async()=>{
  const f=fixture();await withServer({aaroUsageIngress:f.ingress},async port=>{
    for(const headers of [{host:'attacker.invalid'},{host:'apiwild.com:443'},{origin:'https://attacker.invalid'},{'x-forwarded-host':'attacker.invalid'},{'x-forwarded-host':'apiwild.com, attacker.invalid'},{'x-forwarded-proto':'http'},{'x-forwarded-proto':'https, http'},{'x-forwarded-proto':null},{forwarded:'host=apiwild.com;proto=https'},{'oai-authenticated-user-id':USER}])assert.equal((await invoke(port,{headers})).status,403);
    assert.equal((await invoke(port,{headers:{'x-forwarded-host':'apiwild.com'}})).status,200);assert.equal(f.seen.reserve,1);
  });
});
test('duplicate security headers, malformed private key, auth and content encoding fail before customer lookup',async()=>{
  const f=fixture();await withServer({aaroUsageIngress:f.ingress},async port=>{
    assert.equal((await invoke(port,{headers:{origin:['https://apiwild.com','https://apiwild.com']}})).status,400);
    for(const headers of [{'x-aaro-bridge':'é'.repeat(32)},{'x-aaro-bridge':'incorrect'},{authorization:''}])assert.equal((await invoke(port,{headers})).status,403);
    assert.equal((await invoke(port,{headers:{'content-encoding':'gzip'}})).status,415);assert.equal((await invoke(port,{headers:{'content-type':'text/plain'}})).status,415);
    assert.equal((await invoke(port,{method:'GET'})).status,405);assert.equal((await invoke(port,{method:'PUT'})).status,405);assert.equal(f.seen.verify.length,0);assert.equal(f.seen.reserve,0);
  });
});
test('declared and chunked body size bounds reject without retaining customer data or reaching RPC',async()=>{
  const f=fixture();await withServer({aaroUsageIngress:f.ingress},async port=>{
    assert.equal((await invoke(port,{raw:'x'.repeat(4097)})).status,413);assert.equal((await invoke(port,{raw:'x'.repeat(4097),chunked:true})).status,413);assert.equal((await invoke(port,{raw:'{'})).status,400);
    assert.equal(f.seen.verify.length,0);assert.equal(f.seen.reserve,0);
  });
});
test('whole ingress deadline bounds an unfinished body and propagates abort into pending verified lookup',async()=>{
  const f=fixture({deadlineMilliseconds:35});await withServer({aaroUsageIngress:f.ingress},async port=>{assert.equal((await invoke(port,{raw:'{',stall:true})).status,504);assert.equal(f.seen.verify.length,0);});
  let aborted=false;const waiting=fixture({deadlineMilliseconds:35,verify:async(token,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('fixture abort'));},{once:true}))});
  await withServer({aaroUsageIngress:waiting.ingress},async port=>{assert.equal((await invoke(port)).status,504);assert.equal(aborted,true);assert.equal(waiting.seen.reserve,0);});
});
test('late customer lookup cannot reserve new units after the ingress deadline',async()=>{
  const f=fixture({deadlineMilliseconds:35,verify:async()=>{await new Promise(resolve=>setTimeout(resolve,80));return {id:USER};}});
  await withServer({aaroUsageIngress:f.ingress},async port=>{assert.equal((await invoke(port)).status,504);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.seen.reserve,0);});
});
test('disconnect cancels pending customer lookup without reservation or unhandled server rejection',async()=>{
  let entered,aborted=false;const ready=new Promise(resolve=>entered=resolve),f=fixture({verify:async(token,signal)=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('fixture disconnected'));},{once:true}));}});
  await withServer({aaroUsageIngress:f.ingress},async port=>{
    const raw=body(),request=httpRequest({host:'127.0.0.1',port,path:'/api/aaro/usage',method:'POST',agent:false,headers:{host:'apiwild.com',origin:'https://apiwild.com','x-forwarded-proto':'https','content-type':'application/json',authorization:'Bearer fixture-customer-token','x-aaro-bridge':key,'content-length':Buffer.byteLength(raw)}});request.on('error',()=>{});request.end(raw);await ready;request.destroy();
    for(let i=0;i<20&&!aborted;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(aborted,true);assert.equal(f.seen.reserve,0);
  });
});
test('finite per-process concurrency protects stalled work without opening other API WILD/Stripe routes',async()=>{
  let entered,release;const ready=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve),f=fixture({maxConcurrent:1,verify:async()=>{entered();await hold;return {id:USER};}});
  await withServer({aaroUsageIngress:f.ingress,stripeWebhookIngress:createStripeWebhookIngress({enabled:false})},async port=>{
    const pending=invoke(port);await ready;assert.equal((await invoke(port)).status,503);assert.equal(f.seen.verify.length,1);release();assert.equal((await pending).status,200);
    assert.equal((await invoke(port,{path:'/api/billing/webhook'})).status,503);assert.equal((await invoke(port,{path:'/api/gateway'})).status,503);const health=await invoke(port,{path:'/health/live',method:'GET'});assert.equal(health.status,200);assert.equal(health.body.ready,false);
  });
});
test('native ingress configuration remains finite and is never an environment activation switch',()=>{
  const bridge=createAaroUsageBridge();for(const patch of [{deadlineMilliseconds:0},{deadlineMilliseconds:15001},{maxConcurrent:0},{maxConcurrent:17},{enabled:true}])assert.throws(()=>createAaroUsageIngress({bridge,...patch}));
});
