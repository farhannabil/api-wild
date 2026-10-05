import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCustomerKeyRpc, CUSTOMER_KEY_RPC_NAMES } from '../runtime/customer-key-rpc.mjs';
import { SUPABASE_ORIGIN } from '../runtime/supabase-gateway-rpc.mjs';
const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET = 'sb_secret_syntheticOnlyNotReal000001';
const TOKEN = 'aw_test_' + 'a'.repeat(64);
const SESSION = 'Bearer synthetic.session.signature';
const expiry = () => new Date(Date.now()+86400000).toISOString();
const metadata = patch => ({ id: ID, customer_id: CUSTOMER, billing_mode: 'test', scopes: ['chat'], daily_limit_usd_micros: 100, total_limit_usd_micros: 1000, expires_at: expiry(), revoked_at: null, ...patch });
function fixture(options = {}) {
  const calls=[]; let ownerCalls=0;
  const client=createCustomerKeyRpc({ supabaseOrigin: SUPABASE_ORIGIN, secretKey: SECRET, billingMode: 'test', timeoutMs: 100,
    verifyOwner: async ({authorization}) => { ownerCalls++; assert.equal(authorization,SESSION); if(options.rejectOwner) throw new Error('unverified'); return {customerId:CUSTOMER,billingMode:'test'}; },
    fetchImpl: async (url,init) => {
      const operation=Object.keys(CUSTOMER_KEY_RPC_NAMES).find(k=>url.endsWith('/'+CUSTOMER_KEY_RPC_NAMES[k])); const p=JSON.parse(init.body); calls.push({operation,p,url,init});
      if(options.handler) return options.handler(operation,p,init);
      const row=metadata(operation==='issue'?{id:p.p_id,scopes:p.p_scopes,daily_limit_usd_micros:p.p_daily_limit,total_limit_usd_micros:p.p_total_limit,expires_at:p.p_expires_at}:operation==='revoke'?{id:p.p_id,revoked_at:new Date().toISOString()}:{});
      return Response.json(operation==='list'?[row]:row);
    }});
  return {client,calls,get ownerCalls(){return ownerCalls;}};
}
const issue = f => f.client.issue({authorization:SESSION,scopes:['chat'],dailyLimitUsdMicros:100,totalLimitUsdMicros:1000,expiresAt:expiry()});
test('issuance reveals random key once, transports only SHA256 hash, and verifies session owner',async()=>{
  const f=fixture();const x=await issue(f); assert.match(x.key,/^aw_test_[a-f0-9]{64}$/);assert.equal(f.ownerCalls,1);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].p.p_hash,createHash('sha256').update(x.key).digest('hex'));assert.ok(!JSON.stringify(f.calls).includes(x.key));assert.ok(!JSON.stringify(x.metadata).includes(f.calls[0].p.p_hash));
  assert.equal(f.calls[0].p.p_owner,'test:supabase:'+CUSTOMER);assert.equal(f.calls[0].init.redirect,'error');assert.ok(f.calls[0].url.startsWith(SUPABASE_ORIGIN));
  assert.notEqual((await issue(f)).key,x.key);
});
test('listing/revocation expose only own public metadata, and never raw or hashed keys',async()=>{
  const f=fixture();assert.equal((await f.client.list({authorization:SESSION})).length,1);
  const row=await f.client.revoke({authorization:SESSION,keyId:ID});assert.ok(row.revoked_at);assert.equal(f.ownerCalls,2);assert.equal(f.calls[1].p.p_owner,'test:supabase:'+CUSTOMER);
});
test('API key authentication hashes key without treating it as Supabase session',async()=>{
  const f=fixture(); const context=await f.client.authenticate({authorization:'Bearer '+TOKEN,capability:'chat'});
  assert.equal(f.ownerCalls,0);assert.equal(context.customerId,CUSTOMER);assert.equal(context.keyId,ID);assert.equal(f.calls[0].p.p_hash,createHash('sha256').update(TOKEN).digest('hex'));
  assert.ok(!JSON.stringify(f.calls).includes(TOKEN));assert.equal(f.client.assertContext(context,'chat'),context);
  assert.throws(()=>f.client.assertContext({...context},'chat'));assert.throws(()=>f.client.assertContext(context,'code'));
});
test('wrong mode, malformed key and invalid capability never call RPC',async()=>{
  const f=fixture(); for(const authorization of ['Bearer aw_live_'+'a'.repeat(64),'Bearer '+TOKEN+' extra','Bearer aw_test_short',SESSION])await assert.rejects(f.client.authenticate({authorization,capability:'chat'}));
  await assert.rejects(f.client.authenticate({authorization:'Bearer '+TOKEN,capability:'admin'}));assert.equal(f.calls.length,0);
});
test('unverified customer cannot create, list or revoke keys',async()=>{
  const f=fixture({rejectOwner:true});await assert.rejects(issue(f));await assert.rejects(f.client.list({authorization:SESSION}));await assert.rejects(f.client.revoke({authorization:SESSION,keyId:ID}));assert.equal(f.calls.length,0);
});
test('invalid scopes, limits and expiry reject before network',async()=>{
  const f=fixture();const raw={authorization:SESSION,scopes:['chat'],dailyLimitUsdMicros:100,totalLimitUsdMicros:1000,expiresAt:expiry()};
  for(const patch of [{scopes:['chat','chat']},{scopes:['admin']},{dailyLimitUsdMicros:2000},{totalLimitUsdMicros:-1},{expiresAt:'yesterday'},{expiresAt:new Date(Date.now()-1000).toISOString()},{customerId:OTHER}])await assert.rejects(f.client.issue({...raw,...patch}));assert.equal(f.calls.length,0);
});
test('cross-owner/secret-bearing/malformed metadata cannot be exposed',async()=>{
  for(const patch of [{customer_id:OTHER},{hash:'a'.repeat(64)},{key:TOKEN},{scopes:['admin']},{billing_mode:'live'}]){
    const f=fixture({handler:()=>Response.json([metadata(patch)])});await assert.rejects(f.client.list({authorization:SESSION}));
  }
});
test('revoked, expired and out-of-scope key results cannot mint authority',async()=>{
  for(const patch of [{revoked_at:new Date().toISOString()},{expires_at:new Date(Date.now()-1000).toISOString()},{scopes:['code']}]){
    const f=fixture({handler:()=>Response.json(metadata(patch))});await assert.rejects(f.client.authenticate({authorization:'Bearer '+TOKEN,capability:'chat'}));
  }
});
test('ambiguous issue failure neither returns generated key nor retries',async()=>{
  const f=fixture({handler:()=>{throw new Error(SECRET);}});await assert.rejects(issue(f),e=>e.ambiguous&&!e.message.includes(SECRET)&&!e.message.includes('aw_test_'));assert.equal(f.calls.length,1);
});
test('HTTP/oversized/credential-echo responses remain fail closed',async()=>{
  for(const handler of [()=>new Response(SECRET,{status:500}),()=>Response.json({secret:SECRET}),()=>new Response('x'.repeat(131073),{headers:{'content-type':'application/json'}})]){
    const f=fixture({handler});await assert.rejects(f.client.list({authorization:SESSION}),e=>e.ambiguous&&!e.message.includes(SECRET));assert.equal(f.calls.length,1);
  }
});
