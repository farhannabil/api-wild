import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer,request as httpRequest} from 'node:http';
import {createOwnedGatewayFromEnv} from '../runtime/owned-gateway-assembly.mjs';
import {resolvePrepaidSmartRoute,SMART_MODEL,assertPrepaidRoutingEnvelope} from '../runtime/prepaid-smart-router.mjs';
import {normalizeChatRequest} from '../runtime/chat-compatibility.mjs';
import {conversion,status} from './supplier-receipt-fixture.mjs';
const catalog=JSON.parse(readFileSync(new URL('../../../data/selected-supplier-models.json',import.meta.url),'utf8'));
const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',KEY='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',BUDGET='cccccccc-cccc-4ccc-8ccc-cccccccccccc',ID='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TOKEN='aw_test_'+'a'.repeat(64),STAMP=new Date().toISOString();
const requestBody={model:SMART_MODEL,messages:[{role:'user',content:'Synthetic test'}],max_tokens:128,stream:false};
const tools=[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}}];
function fixture({quotaDenied=false,supplierFailed=false,enabled=true,textAvailable=true}={}){
 let stored,dispatches=0,finishes=0;const transmitted=[];
 const routes=['gemini-3.1-flash-lite','MiniMax-M2.7-highspeed'].filter(m=>textAvailable||m!=='gemini-3.1-flash-lite').map(model=>({providerBudgetId:BUDGET,model,upstreamModel:model,capability:'chat',maxOutputTokens:128,maxInputTokens:4096,maxInputChars:4096,supplierReserveCnyMicros:1000000,supplierSlug:catalog.models.find(m=>m.model_name===model).primary.supplier_slug,supportsTools:model==='MiniMax-M2.7-highspeed'}));
 const port=createOwnedGatewayFromEnv({catalog,env:{APIWILD_OWNED_GATEWAY_ENABLED:'true',APIWILD_INFERENCE_ENABLED:'true',APIWILD_SMART_ROUTER_ENABLED:String(enabled),APIWILD_GATEWAY_ROUTES_JSON:JSON.stringify(routes),APIWILD_RETAIL_RATE_VERSION:'fixture-v1',APIWILD_BILLING_MODE:'test',SUPABASE_SECRET_KEY:'sb_secret_syntheticFixtureOnly000000',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_syntheticFixtureOnly000000',SUBROUTER_API_KEY:'sk-syntheticFixtureOnly000000',APIWILD_SUPPLIER_CONVERSION_JSON:JSON.stringify(conversion)},fetchImpl:async(url,init)=>{
  if(url==='https://subrouter.ai/api/status')return Response.json({success:true,data:status});
  if(url==='https://subrouter.ai/v1/chat/completions'){
   dispatches++;const body=JSON.parse(init.body);transmitted.push(body);
   if(supplierFailed)return Response.json({error:'synthetic unavailable'},{status:503});
   const message=body.tools?{role:'assistant',content:null,tool_calls:[{id:'call_fixture',type:'function',function:{name:'echo',arguments:'{"text":"OK"}'}}]}:{role:'assistant',content:'OK'};
   return Response.json({id:'completion_fixture',model:body.model,usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12},choices:[{index:0,message,finish_reason:body.tools?'tool_calls':'stop'}]},{headers:{'x-request-id':'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}});
  }
  const p=JSON.parse(init.body);
  if(url.endsWith('key_authenticate'))return Response.json({id:KEY,customer_id:USER,billing_mode:'test',scopes:['chat'],daily_limit_usd_micros:10000,total_limit_usd_micros:10000,expires_at:new Date(Date.now()+3600000).toISOString(),revoked_at:null});
  if(url.endsWith('apiwild_gateway_reserve')){
   if(quotaDenied)return Response.json({code:'P0001',message:'gateway_key_limit'},{status:400});
   if(stored){if(stored.payload_hash!==p.p_payload_hash)return Response.json({code:'P0001',message:'gateway_idempotency_conflict'},{status:400});return Response.json({fresh:false,record:stored});}
   stored={id:ID,user_id:p.p_owner,key_id:p.p_key_id,provider_budget_id:p.p_provider_budget_id,request_key:p.p_request_key,payload_hash:p.p_payload_hash,capability:p.p_capability,model:p.p_model,rate_version:p.p_rate_version,state:'reserved',version:0,reserved_usd_micros:p.p_reserved_usd_micros,reserved_cny_micros:p.p_reserved_cny_micros,cost_usd_micros:0,cost_cny_micros:0,observed_cny_micros:0,pricing_bound_exceeded:false,settlement_reference:null,result_json:null,usage_json:{},created_at:STAMP,updated_at:STAMP,expires_at:new Date(Date.now()+3600000).toISOString()};return Response.json({fresh:true,record:stored});
  }
  if(url.endsWith('apiwild_gateway_claim')){stored={...stored,state:'executing',version:1};return Response.json({claimed:true,record:stored});}
  if(url.endsWith('apiwild_gateway_finish_retail')){finishes++;stored={...stored,state:p.p_state,version:2,cost_usd_micros:p.p_cost_usd_micros,cost_cny_micros:p.p_cost_cny_micros,observed_cny_micros:p.p_cost_cny_micros,settlement_reference:p.p_settlement_reference,result_json:p.p_result,usage_json:p.p_usage};return Response.json({settled:true,replayed:false,record:stored});}
  if(url.endsWith('apiwild_gateway_uncertain')){stored={...stored,state:'uncertain',version:2};return Response.json({replayed:false,record:stored});}
  throw Error('Unexpected synthetic transport');
 }});
 return {port,transmitted,get state(){return {stored,dispatches,finishes};}};
}
async function serve(f,run){const app=createServer((req,res)=>f.port.handle(req,res));await new Promise(r=>app.listen(0,'127.0.0.1',r));try{return await run(body=>new Promise((resolve,reject)=>{const bytes=JSON.stringify(body);const req=httpRequest({host:'127.0.0.1',port:app.address().port,path:'/v1/chat/completions',method:'POST',headers:{host:'apiwild.com',authorization:'Bearer '+TOKEN,'content-type':'application/json','content-length':Buffer.byteLength(bytes),'idempotency-key':'smart_fixture_request_01'}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>resolve({status:res.statusCode,text,json:res.headers['content-type'].startsWith('application/json')?JSON.parse(text):null}));});req.on('error',reject);req.end(bytes);}));}finally{await new Promise(r=>app.close(r));}}

test('real HTTP assembly resolves the text alias, reserves USD, settles and replays without a second dispatch',async()=>{const f=fixture();await serve(f,async send=>{const first=await send(requestBody);assert.equal(first.status,200);assert.equal(first.json.model,'gemini-3.1-flash-lite');assert.ok(f.state.stored.reserved_usd_micros>f.state.stored.cost_usd_micros);assert.equal((await send(requestBody)).status,200);assert.equal(f.state.dispatches,1);assert.equal(f.state.finishes,1);assert.equal((await send({...requestBody,messages:[{role:'user',content:'Changed'}]})).status,409);assert.equal(f.state.dispatches,1);assert.equal((await send({...requestBody,model:'gemini-3.1-flash-lite'})).status,409);});assert.equal(f.transmitted[0].model,'gemini-3.1-flash-lite');assert.equal(f.transmitted[0].routing,undefined);assert.equal(f.transmitted[0].model.includes('apiwild'),false);});
test('function-data requests select only the tool-enabled route and expose its actual model',async()=>{const f=fixture();await serve(f,async send=>{const r=await send({...requestBody,tools,tool_choice:'auto',parallel_tool_calls:false});assert.equal(r.status,200);assert.equal(r.json.model,'MiniMax-M2.7-highspeed');assert.equal(r.json.choices[0].message.tool_calls[0].function.name,'echo');});assert.equal(f.state.dispatches,1);});
test('buffered streaming retains the selected model and settles once before delivery',async()=>{const f=fixture();await serve(f,async send=>{const r=await send({...requestBody,stream:true,stream_options:{include_usage:true}});assert.equal(r.status,200);assert.ok(r.text.includes('gemini-3.1-flash-lite'));assert.ok(r.text.includes('data: [DONE]'));assert.equal(f.state.finishes,1);});});
test('existing key quota denial prevents every supplier call',async()=>{const f=fixture({quotaDenied:true});await serve(f,async send=>{assert.equal((await send(requestBody)).status,402);assert.equal(f.state.dispatches,0);assert.equal(f.state.finishes,0);});});
test('uncertain supplier delivery stays held on repeat and never falls back to another model',async()=>{const f=fixture({supplierFailed:true});await serve(f,async send=>{assert.equal((await send(requestBody)).status,503);assert.equal(f.state.stored.state,'uncertain');assert.equal((await send(requestBody)).status,503);assert.equal(f.state.dispatches,1);assert.equal(f.state.finishes,0);});});
test('disabled or unavailable smart routes fail before supplier spending',async()=>{for(const patch of [{enabled:false},{textAvailable:false}]){const f=fixture(patch);await serve(f,async send=>{assert.equal((await send(requestBody)).status,503);assert.equal(f.state.dispatches,0);});}const f=fixture();assert.equal(f.port.discovery.config.smartRouting.model,SMART_MODEL);assert.equal(f.port.discovery.catalog.count,2);assert.equal(f.port.discovery.v1Models.data.some(m=>m.id===SMART_MODEL),false);});
test('routing envelope cannot invent a policy or mismatch the actual route, and explicit models stay explicit',()=>{const input=normalizeChatRequest({...requestBody,model:'claude-opus-4-8'});assert.equal(resolvePrepaidSmartRoute(input).input,input);assert.throws(()=>assertPrepaidRoutingEnvelope({alias:SMART_MODEL,policyVersion:'unreviewed'},requestBody));assert.throws(()=>assertPrepaidRoutingEnvelope({alias:SMART_MODEL,policyVersion:'usd-v1'},{...requestBody,model:'claude-opus-4-8'}));assert.throws(()=>resolvePrepaidSmartRoute(normalizeChatRequest(requestBody),{native:true}));});
