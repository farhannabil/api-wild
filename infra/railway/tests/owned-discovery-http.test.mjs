import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
import {createPreparationServer} from '../preparation-server.mjs';
import {createOwnedGatewayFromEnv} from '../runtime/owned-gateway-assembly.mjs';
import {createOwnedDiscoverySnapshot,createOwnedDiscoveryHttp} from '../runtime/owned-discovery-http.mjs';

const catalog=JSON.parse(await readFile(new URL('../../../data/selected-supplier-models.json',import.meta.url),'utf8'));
const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OTHER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',KEY='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN='aw_test_'+'a'.repeat(64),SESSION='Bearer synthetic.session.signature';
const env={APIWILD_OWNED_GATEWAY_ENABLED:'true',SUPABASE_SECRET_KEY:'sb_secret_syntheticFixtureOnly000000',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_syntheticFixtureOnly000000',APIWILD_BILLING_MODE:'test',RAILWAY_GIT_COMMIT_SHA:'c'.repeat(40)};
const wallet={currency:'USD',fundedUsdMicros:30000000,spentUsdMicros:1200000,reservedUsdMicros:500000,paymentHoldUsdMicros:0,availableUsdMicros:28300000,completedRequests:2};
function fixture(patch={}){
  const calls=[];
  const gatewayHttp=createOwnedGatewayFromEnv({env:{...env,...patch.env},catalog,fetchImpl:async(url,init)=>{
    const p=init.body?JSON.parse(init.body):null;calls.push({url,p,headers:init.headers});
    if(url.endsWith('/auth/v1/user')) {
      if(patch.invalidSession)return Response.json({error:'private database detail'},{status:401});
      assert.equal(init.headers.authorization,SESSION);
      return Response.json({id:USER,email:'private@example.test',email_confirmed_at:new Date().toISOString(),is_anonymous:false});
    }
    if(url.endsWith('key_authenticate'))return Response.json({id:KEY,customer_id:USER,billing_mode:'test',scopes:patch.scopes??['chat'],daily_limit_usd_micros:null,total_limit_usd_micros:null,expires_at:null,revoked_at:patch.revoked?new Date().toISOString():null});
    if(url.endsWith('gateway_usage')){assert.deepEqual(p,{p_owner:'test:supabase:'+USER});return Response.json({...wallet,...patch.wallet});}
    throw Error('Unexpected RPC or write');
  }});
  return {gatewayHttp,discoveryHttp:createOwnedDiscoveryHttp({snapshot:gatewayHttp.discovery}),calls};
}
async function server(f,run){const app=createPreparationServer(f);await new Promise(r=>app.listen(0,'127.0.0.1',r));try{return await run((path,headers={},method='GET',body)=>new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:app.address().port,path,method,headers:{host:'apiwild.com',...headers}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw,body:raw?JSON.parse(raw):null}));});req.on('error',reject);req.end(body);
}));}finally{await new Promise(r=>app.close(r));}}

test('public discovery exposes all retail models and truthful inactive capabilities without transport or supplier data',async()=>{
  const f=fixture();await server(f,async call=>{
    const models=await call('/api/models'),config=await call('/api/gateway/config');
    assert.equal(models.status,200);assert.equal(models.body.count,39);assert.equal(models.body.models.length,39);
    assert.equal(models.body.authority,'apiwild-owned-runtime');assert.ok(models.body.models.every(model=>model.callable===false&&model.pricing.currency==='USD'&&model.capabilities.length===0));
    assert.equal(config.status,200);assert.equal(config.body.deploymentCommit,env.RAILWAY_GIT_COMMIT_SHA);assert.equal(config.body.inferenceConfigured,false);assert.equal(config.body.enabled,false);
    assert.ok(Object.values(config.body.ready).every(value=>value===false));assert.equal(config.body.streaming,false);assert.equal(config.body.externalTools,false);
    for(const forbidden of ['supplier','primary','backup','offer_id','fx','CNY','apiKey','sb_secret_','sb_publishable_'])assert.ok(!models.raw.includes(forbidden)&&!config.raw.includes(forbidden),forbidden);
    assert.equal((await call('/health/ready')).status,503);assert.equal(f.calls.length,0);
  });
});

test('public route snapshots allow only configured approved model capabilities and validate commit identity',()=>{
  const active=createOwnedDiscoverySnapshot({catalog,routes:[{model:'claude-fable-5',capability:'code',maxOutputTokens:1000,apiKey:'must-not-be-public',supplierReserveCnyMicros:99}],rateVersion:'accepted-v1'});
  assert.equal(active.config.deploymentCommit,null);assert.equal(active.config.ready.code,true);assert.equal(active.config.ready.chat,false);
  assert.equal(active.catalog.models.filter(model=>model.callable).length,1);assert.equal(active.v1Models.data.find(model=>model.id==='claude-fable-5').available,true);
  assert.ok(!JSON.stringify(active).includes('must-not-be-public'));assert.throws(()=>active.catalog.models.push({}));
  for(const deploymentCommit of ['G'.repeat(40),'abc','x\n'+ 'a'.repeat(40),123])assert.equal(createOwnedDiscoverySnapshot({catalog,deploymentCommit}).config.deploymentCommit,null);
  assert.throws(()=>createOwnedDiscoverySnapshot({catalog,routes:[{model:'unapproved',capability:'chat',maxOutputTokens:1000}]}));
  assert.throws(()=>createOwnedDiscoverySnapshot({catalog,routes:[{model:'claude-fable-5',capability:'voice',maxOutputTokens:1000}]}));
  assert.throws(()=>createOwnedDiscoveryHttp({snapshot:{catalog:{models:[]}}}));
  assert.throws(()=>createPreparationServer({discoveryHttp:{handle(){}}}));
});

test('protected read routes establish real owner or scoped key identity and return owner-bound retail data',async()=>{
  const f=fixture();await server(f,async call=>{
    for(const path of ['/api/account','/v1/models','/v1/usage'])assert.equal((await call(path)).status,401);
    assert.equal(f.calls.length,0);
    const account=await call('/api/account',{authorization:SESSION});assert.equal(account.status,200);
    assert.deepEqual(account.body,{authority:'supabase',user:{id:USER},billingMode:'test',profileAvailable:false});assert.ok(!account.raw.includes('private@example.test'));
    const models=await call('/v1/models',{authorization:'Bearer '+TOKEN});assert.equal(models.status,200);assert.equal(models.body.object,'list');assert.equal(models.body.data.length,39);assert.equal(models.body.inference_available,false);
    const usage=await call('/v1/usage',{authorization:'Bearer '+TOKEN});assert.equal(usage.status,200);assert.deepEqual(usage.body,wallet);assert.equal(usage.headers['cache-control'],'private, no-store');
    const checks=f.calls.filter(call=>call.url.endsWith('key_authenticate'));assert.equal(checks.length,2);assert.ok(checks.every(call=>call.p.p_hash===createHash('sha256').update(TOKEN).digest('hex')&&call.p.p_capability==='chat'));
    assert.ok(!JSON.stringify(f.calls).includes(TOKEN));assert.ok(!usage.raw.includes(USER));assert.ok(!usage.raw.includes('supplier'));
  });
});

test('invalid sessions and revoked or out-of-scope keys cannot access account or usage; capability-scoped read succeeds',async()=>{
  const invalid=fixture({invalidSession:true});await server(invalid,async call=>assert.equal((await call('/api/account',{authorization:SESSION})).status,401));
  const revoked=fixture({revoked:true});await server(revoked,async call=>{assert.equal((await call('/v1/usage',{authorization:'Bearer '+TOKEN})).status,403);assert.equal(revoked.calls.length,1);});
  const scoped=fixture({scopes:['code']});await server(scoped,async call=>{
    assert.equal((await call('/v1/usage',{authorization:'Bearer '+TOKEN})).status,403);
    assert.equal((await call('/v1/usage',{authorization:'Bearer '+TOKEN,'x-apiwild-capability':'code'})).status,200);
    assert.equal((await call('/v1/models',{authorization:SESSION})).status,401);
    assert.equal((await call('/api/account',{authorization:'Bearer '+TOKEN})).status,401);
  });
});

test('API model availability reflects the verified key capability rather than another configured mode',async()=>{
  const route={providerBudgetId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',model:'claude-fable-5',upstreamModel:'claude-fable-5',capability:'code',maxOutputTokens:1000,maxInputTokens:1000,maxInputChars:1000,supplierReserveCnyMicros:1000000,supplierSlug:'viapi'};
  const f=fixture({scopes:['chat','code'],env:{APIWILD_INFERENCE_ENABLED:'true',SUBROUTER_API_KEY:'sk-syntheticFixtureOnly000000',APIWILD_RETAIL_RATE_VERSION:'fixture-v1',APIWILD_GATEWAY_ROUTES_JSON:JSON.stringify([route])}});
  await server(f,async call=>{
    const chat=await call('/v1/models',{authorization:'Bearer '+TOKEN});assert.equal(chat.status,200);assert.equal(chat.body.inference_available,false);assert.ok(chat.body.data.every(model=>model.available===false));
    const code=await call('/v1/models',{authorization:'Bearer '+TOKEN,'x-apiwild-capability':'code'});assert.equal(code.status,200);assert.equal(code.body.inference_available,true);assert.deepEqual(code.body.data.filter(model=>model.available).map(model=>model.id),['claude-fable-5']);
    assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.url.endsWith('key_authenticate')));
  });
});

test('discovery and protected reads reject forged identity, origins, bodies and queries without writes',async()=>{
  const f=fixture();await server(f,async call=>{
    for(const path of ['/api/models','/api/gateway/config','/api/account','/v1/models','/v1/usage']){
      const authorization=path.startsWith('/v1/')?'Bearer '+TOKEN:SESSION;
      for(const headers of [{host:'evil.invalid'},{origin:'https://evil.invalid'},{'oai-authenticated-user-id':OTHER}])assert.equal((await call(path,{authorization,...headers})).status,403);
      assert.equal((await call(path,{authorization},'POST')).status,405);
      assert.ok((await call(path+'?owner='+OTHER,{authorization})).status>=400);
      assert.equal((await call(path,{authorization,'content-length':'2'},'GET','{}')).status,400);
    }
    assert.equal(f.calls.length,0);
  });
});

test('malformed retail usage RPC cannot become an authenticated success response',async()=>{
  const f=fixture({wallet:{supplierCost:77}});await server(f,async call=>{const result=await call('/v1/usage',{authorization:'Bearer '+TOKEN});assert.ok(result.status>=400);assert.ok(!result.raw.includes('supplierCost'));});
});
