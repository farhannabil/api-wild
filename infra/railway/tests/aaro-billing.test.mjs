// Real Node HTTP fixture on a new loopback ephemeral port; synthetic services only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createAaroBillingFromEnv,isAaroBilling} from '../runtime/aaro-billing.mjs';
import {createAaroUsageFromEnv} from '../runtime/aaro-usage-assembly.mjs';
const user='12345678-1234-4123-8123-123456789abc',owner='live:supabase:'+user;
const env={AARO_BILLING_ENABLED:'true',SUPABASE_SECRET_KEY:'sb_secret_OFFLINEFIXTURENOTREALKEY',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_OFFLINEFIXTURENOTREALKEY'};
async function fixture(vars={},override){
 const calls=[];const adapter=await createAaroBillingFromEnv(vars,{fetchImpl:async(url,opts)=>{calls.push({url,opts});if(override)return override(url,opts);return Response.json(url.includes('/auth/v1/user')?{id:user,email_confirmed_at:'2026-10-01T00:00:00Z',is_anonymous:false}:{owner,frozen:true,subscriptions:[],creditPeriods:[]});}});
 const server=createServer((req,res)=>void adapter.handle(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const send=(path='/api/aaro/billing',extra={},method='GET',body)=>new Promise((done,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'apiwild.com',origin:'https://apiwild.com','x-forwarded-proto':'https',authorization:'Bearer OfflineFixtureToken',...extra}},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>done({status:res.statusCode,data:JSON.parse(data)}));});req.on('error',reject);req.end(body);});
 return {adapter,calls,send,stop:()=>new Promise(done=>server.close(done))};
}
await test('default, missing credentials, malformed config and unaccepted usage flags perform no calls',async()=>{
 for(const vars of [{},{AARO_BILLING_ENABLED:'true'},{...env,SUPABASE_SECRET_KEY:'invalid'}]){const f=await fixture(vars);try{assert(isAaroBilling(f.adapter));assert.equal((await f.send()).status,503);assert.equal(f.calls.length,0);}finally{await f.stop();}}
 let n=0;assert.equal(createAaroUsageFromEnv({env:{},fetchImpl:()=>++n}),undefined);assert(createAaroUsageFromEnv({env:{AARO_FINANCE_ENABLED:'true'},fetchImpl:()=>++n}));assert.equal(n,0);
});
await test('confirmed auth and separate AARO read show disabled sales and no usable balance',async()=>{
 const f=await fixture(env);try{const reply=await f.send();assert.equal(reply.status,200);assert.equal(reply.data.enabled,false);assert.equal(reply.data.usageEnabled,false);assert.equal(reply.data.creditBalanceAvailable,false);assert.equal(f.calls.length,2);assert(f.calls[1].url.endsWith('/rpc/aaro_billing_read_v1'));assert.equal(JSON.parse(f.calls[1].opts.body).p_owner,owner);assert(!JSON.stringify(reply.data).includes('sb_secret_'));}finally{await f.stop();}
});
await test('spoofed host/origin/forwarding, OAI identity, methods and query parameters cannot call finance',async()=>{
 const f=await fixture(env);try{for(const headers of [{host:'evil.example'},{origin:'https://evil.example'},{forwarded:'host=apiwild.com'},{'x-forwarded-proto':'http'},{'oai-authenticated-user':'attacker'}])assert.notEqual((await f.send(undefined,headers)).status,200);assert.equal((await f.send('/api/aaro/billing?owner=attacker')).status,503);assert.equal((await f.send(undefined,{},'POST')).status,405);assert.equal(f.calls.length,0);}finally{await f.stop();}
});
await test('unconfirmed/anonymous identity fails before private billing RPC',async()=>{
 for(const patch of [{is_anonymous:true},{email_confirmed_at:null},{id:'wrong'}]){const f=await fixture(env,async()=>Response.json({id:user,email_confirmed_at:'2026-10-01T00:00:00Z',is_anonymous:false,...patch}));try{assert.equal((await f.send()).status,403);assert.equal(f.calls.length,1);}finally{await f.stop();}}
});
await test('credentials alone do not open checkout; missing webhook rejects raw funding before reads',async()=>{
 const f=await fixture(env);try{assert.equal((await f.send('/api/aaro/checkout',{'content-type':'application/json'},'POST','{"plan":"global-starter","returnTo":"aaro"}')).status,503);const prior=f.calls.length;assert.equal((await f.send('/api/aaro/webhook',{'content-type':'application/json','stripe-signature':'bad'},'POST','{}')).status,503);assert.equal(f.calls.length,prior);}finally{await f.stop();}
});
