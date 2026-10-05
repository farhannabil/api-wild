import test from 'node:test';
import assert from 'node:assert/strict';
import {createGatewayIngress} from '../runtime/gateway-ingress.mjs';
import {createGatewayHttp} from '../runtime/gateway-http.mjs';
import {createPreparationServer} from '../preparation-server.mjs';
import {createCustomerKeyRpc} from '../runtime/customer-key-rpc.mjs';
import {SUPABASE_ORIGIN, GatewayError} from '../runtime/supabase-gateway-rpc.mjs';
import {createResearchTools} from '../runtime/research-tools.mjs';
import {request as httpRequest} from 'node:http';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', keyId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const session='Bearer fixture.session.signature', key='Bearer aw_test_'+'a'.repeat(64);
function fixture({scopes=['research'],researchTools,clock=Date.now}={}){
 const calls={auth:0,tool:0,paid:0,key:[]};
 const keys=createCustomerKeyRpc({supabaseOrigin:SUPABASE_ORIGIN,secretKey:'sb_secret_syntheticFixtureOnly000000',billingMode:'test',verifyOwner:async()=>({customerId:owner,billingMode:'test'}),fetchImpl:async()=>Response.json({id:keyId,customer_id:owner,billing_mode:'test',scopes,daily_limit_usd_micros:null,total_limit_usd_micros:null,expires_at:null,revoked_at:null})});
 const rpc={verifyOwner:async()=>{calls.auth++;return {customerId:owner,billingMode:'test'};},verifyKeyOwner:async input=>{calls.key.push(input.capability);return keys.authenticate(input);}};
 const tools=researchTools??createResearchTools();
 const ingress=createGatewayIngress({rpc,keys,service:{execute:async()=>{calls.paid++;throw Error('No paid request');}},selectQuote:async()=>{throw Error('No quote');},origin:'https://apiwild.com',enabled:true,clock,researchTools:{execute:async(...args)=>{calls.tool++;return tools.execute(...args);}}});
 return {ingress,calls};
}
const request=(body={tool:'calculate',expression:'(2+3)*4'},headers={},path='/api/research/tools',signal)=>new Request('https://apiwild.com'+path,{method:'POST',headers:{authorization:session,'content-type':'application/json',...headers},body:JSON.stringify(body),...(signal?{signal}:{})});

test('tools authenticate before dependencies; reject origins and forged identity headers',async()=>{
 for(const headers of [{authorization:''},{authorization:'Bearer invalid'},{origin:'https://evil.test'},{'oai-authenticated-user-id':owner}]){
  const f=fixture(), response=await f.ingress.handle(request(undefined,headers));
  assert.ok([401,403].includes(response.status));assert.equal(f.calls.tool,0);assert.equal(f.calls.auth,0);assert.equal(f.calls.paid,0);
 }
});
test('signed-in calculator needs no wallet reservation, supplier call or idempotency key',async()=>{
 const f=fixture(),response=await f.ingress.handle(request());
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,tool:'calculate',expression:'(2+3)*4',result:20});
 assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(f.calls.auth,1);assert.equal(f.calls.paid,0);
});
test('only research-scoped customer keys can run tools',async()=>{
 const permitted=fixture(), response=await permitted.ingress.handle(request(undefined,{authorization:key}));
 assert.equal(response.status,200);assert.deepEqual(permitted.calls.key,['research']);assert.equal(permitted.calls.auth,0);
 const denied=fixture({scopes:['chat']}),blocked=await denied.ingress.handle(request(undefined,{authorization:key}));
 assert.equal(blocked.status,403);assert.equal(denied.calls.tool,0);assert.equal(denied.calls.paid,0);
});
test('invalid sources and executable expressions cannot reach auth or utility dependencies',async()=>{
 for(const input of [{tool:'read',url:'http://127.0.0.1/admin'},{tool:'read',url:'https://evil.test/'},{tool:'calculate',expression:'process.env'},{tool:'search',query:'x',authorization:key}]){
  const f=fixture(),response=await f.ingress.handle(request(input));assert.equal(response.status,400);assert.equal(f.calls.auth,0);assert.equal(f.calls.tool,0);
 }
});
test('free utilities enforce eight requests per verified owner per minute',async()=>{
 let time=1000;const f=fixture({clock:()=>time});
 for(let i=0;i<8;i++)assert.equal((await f.ingress.handle(request())).status,200);
 const blocked=await f.ingress.handle(request());assert.equal(blocked.status,429);assert.equal((await blocked.json()).code,'research_tools_rate_limit');assert.equal(f.calls.tool,8);
 time+=60000;assert.equal((await f.ingress.handle(request())).status,200);assert.equal(f.calls.paid,0);
});
test('slow free source reads cannot consume paid or account admission slots',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let started=0,ready;const bothStarted=new Promise(resolve=>{ready=resolve;});
 const f=fixture({researchTools:{execute:async()=>{if(++started===2)ready();await gate;return {ok:true,tool:'calculate',expression:'1',result:1};}}});
 const first=f.ingress.handle(request()),second=f.ingress.handle(request());await bothStarted;
 try{assert.equal((await f.ingress.handle(request())).status,503);assert.equal((await f.ingress.handle(new Request('https://apiwild.com/api/account',{headers:{authorization:session}}))).status,200);assert.equal(f.calls.paid,0);}finally{release();}
 assert.equal((await first).status,200);assert.equal((await second).status,200);
});
test('provider details are sanitized and disconnected requests do not start external reads',async()=>{
 const f=fixture({researchTools:{execute:async()=>{throw new GatewayError('research_tools_source_unavailable');}}});
 const response=await f.ingress.handle(request({tool:'search',query:'Canada'}));assert.equal(response.status,503);assert.equal((await response.json()).automaticRetry,false);
 const controller=new AbortController();controller.abort();const stopped=fixture();assert.equal((await stopped.ingress.handle(request(undefined,{},undefined,controller.signal))).status,403);assert.equal(stopped.calls.tool,0);
});
test('production HTTP router mounts tools; rejects absent credentials and wrong host',async()=>{
 const f=fixture(), server=createPreparationServer({gatewayHttp:createGatewayHttp({ingress:f.ingress})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=(host,authorization)=>new Promise((resolve,reject)=>{
  const data=JSON.stringify({tool:'calculate',expression:'6*7'});
  const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path:'/api/research/tools',method:'POST',headers:{host,...(authorization?{authorization}:{}),'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end(data);
 });
 try{assert.equal((await call('apiwild.com')).status,401);assert.equal((await call('other.test',session)).status,403);const result=await call('apiwild.com',session);assert.equal(result.status,200);assert.equal(result.body.result,42);assert.equal(f.calls.paid,0);}finally{await new Promise(resolve=>server.close(resolve));}
});
