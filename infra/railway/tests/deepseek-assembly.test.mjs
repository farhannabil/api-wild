import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {createServer,request} from 'node:http';import {createOwnedGatewayFromEnv} from '../runtime/owned-gateway-assembly.mjs';
import {conversion,status} from './supplier-receipt-fixture.mjs';
const catalog=JSON.parse(await readFile(new URL('../../../data/selected-supplier-models.json',import.meta.url),'utf8'));
const customer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',budget='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const model='deepseek-v4-flash',entry=catalog.models.find(m=>m.model_name===model),baseRateVersion='fixture-v1';
const policy={accepted:true,billingBasis:'apiwild_admission_time',baseRateVersion,sourceRevision:'deepseek-pricing-2026-10-05',calendarVersion:'cn-state-council-2026-7',validFrom:'2026-10-05T00:00:00.000Z',validUntil:'2026-10-12T00:00:00.000Z',servedVersions:{[model]:'DeepSeek-V4.1-Flash'}};
const rates={[model]:{primary:{accepted:true,supplierSlug:entry.primary.supplier_slug,currency:entry.primary.supplier_currency,off_peak:{input:0.05,output:0.2},peak:{input:0.1,output:0.4}}}}; // synthetic supplier fixture only
const route={model,upstreamModel:model,providerBudgetId:budget,capability:'chat',maxOutputTokens:1000,maxInputTokens:1000,maxInputChars:1000,supplierReserveCnyMicros:100000,supplierSlug:entry.primary.supplier_slug};
const env={APIWILD_OWNED_GATEWAY_ENABLED:'true',APIWILD_INFERENCE_ENABLED:'true',APIWILD_BILLING_MODE:'test',SUPABASE_SECRET_KEY:'sb_secret_syntheticFixtureOnly000000',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_syntheticFixtureOnly000000',SUBROUTER_API_KEY:'sk-syntheticFixtureOnly000000',APIWILD_RETAIL_RATE_VERSION:baseRateVersion,APIWILD_GATEWAY_ROUTES_JSON:JSON.stringify([route]),APIWILD_DEEPSEEK_TARIFF_ENABLED:'true',APIWILD_DEEPSEEK_TARIFF_POLICY_JSON:JSON.stringify(policy),APIWILD_DEEPSEEK_SUPPLIER_RATES_JSON:JSON.stringify(rates)};
env.APIWILD_SUPPLIER_CONVERSION_JSON=JSON.stringify(conversion);
test('conditional assembly refuses absent accepted policy or supplier rates without network',()=>{
 for(const patch of [{APIWILD_DEEPSEEK_TARIFF_ENABLED:'false'},{APIWILD_DEEPSEEK_SUPPLIER_RATES_JSON:'{}'},{APIWILD_DEEPSEEK_TARIFF_POLICY_JSON:JSON.stringify({...policy,accepted:false})}])assert.throws(()=>createOwnedGatewayFromEnv({env:{...env,...patch},catalog,fetchImpl:()=>{throw Error('unexpected network');}}));
});
test('admission tariff stays frozen across dispatch boundary and expired-window replay never re-quotes or redispatches',async()=>{
 const supplierRequestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 let now=Date.parse('2026-10-08T00:59:50Z'),clocks=0,row,upstreamCalls=0,finishCost,lookupCount=0;
 const port=createOwnedGatewayFromEnv({env,catalog,clock:()=>{clocks++;return now;},fetchImpl:async(url,init)=>{
  const p=init.body?JSON.parse(init.body):{};
  if(url==='https://subrouter.ai/api/status')return Response.json({success:true,data:status});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:customer,email:'fixture@example.test',email_confirmed_at:'2026-10-05T00:00:00Z',is_anonymous:false});
  if(url.endsWith('account_initialize'))return Response.json({initialized:true,customer_id:customer,billing_mode:'test'});
  if(url.endsWith('quote_lookup')){lookupCount++;assert.equal(p.p_owner,'test:supabase:'+customer);return Response.json(row?{found:true,quote:{model,providerBudgetId:budget,rateVersion:row.rate_version,reservedUsdMicros:row.reserved_usd_micros,reservedCnyMicros:row.reserved_cny_micros}}:{found:false});}
  if(url.endsWith('gateway_reserve')){
   assert.equal(p.p_rate_version,baseRateVersion+':ds26:off_peak');
   if(row)return Response.json({fresh:false,record:row});
   row={id,user_id:p.p_owner,key_id:null,provider_budget_id:budget,request_key:p.p_request_key,payload_hash:p.p_payload_hash,capability:'chat',model,rate_version:p.p_rate_version,state:'reserved',version:0,reserved_usd_micros:p.p_reserved_usd_micros,cost_usd_micros:0,reserved_cny_micros:p.p_reserved_cny_micros,cost_cny_micros:0,observed_cny_micros:0,pricing_bound_exceeded:false,settlement_reference:null,result_json:null,usage_json:{},created_at:'2026-10-08T00:59:50Z',updated_at:'2026-10-08T00:59:50Z',expires_at:'2026-10-08T01:01:50Z'};
   return Response.json({fresh:true,record:row});
  }
  if(url.endsWith('gateway_claim')){row={...row,state:'executing',version:1};return Response.json({claimed:true,record:row});}
  if(url==='https://subrouter.ai/v1/chat/completions'){upstreamCalls++;now=Date.parse('2026-10-08T01:00:10Z');return Response.json({id:'synthetic_response',model,usage:{prompt_tokens:1000,completion_tokens:1000,total_tokens:2000},choices:[{index:0,message:{role:'assistant',content:'fixture'},finish_reason:'stop'}]},{headers:{'x-request-id':supplierRequestId}});}
  if(url.endsWith('finish_retail')){assert.equal(p.p_settlement_reference,'usage:'+supplierRequestId);assert.equal(p.p_usage.providerRequestId,supplierRequestId);assert.equal(p.p_usage.providerCompletionId,'synthetic_response');finishCost=p.p_cost_usd_micros;row={...row,state:'succeeded',version:2,cost_usd_micros:p.p_cost_usd_micros,cost_cny_micros:0,observed_cny_micros:0,settlement_reference:p.p_settlement_reference,result_json:p.p_result,usage_json:p.p_usage,supplier_pending:true};return Response.json({settled:true,replayed:false,record:row});}
  throw Error('unexpected fixture transport');
 }});
 const publicModel=port.discovery.catalog.models.find(row=>row.id===model);
 assert.equal(publicModel.callable,true);assert.deepEqual(publicModel.capabilities,['chat']);
 assert.equal(port.discovery.catalog.models.filter(row=>row.id===model).length,1);
 assert.equal(publicModel.pricing.conditionalPricing,true);assert.ok(publicModel.pricing.peak.input>publicModel.pricing.input);
 assert.equal(port.discovery.config.ready.chat,true);assert.equal(port.discovery.v1Models.data.filter(row=>row.id===model).length,1);
 const server=createServer((req,res)=>port.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=()=>new Promise((resolve,reject)=>{const body=JSON.stringify({model,messages:[{role:'user',content:'Hello'}],max_tokens:1000});const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/gateway',method:'POST',headers:{host:'apiwild.com',authorization:'Bearer fixture.auth.signature','content-type':'application/json','content-length':Buffer.byteLength(body),'idempotency-key':'fixture_request_0001'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end(body);});
 try{const initial=await call();assert.equal(initial.status,200);assert.equal(initial.body.ok,true);assert.equal(finishCost,375);assert.equal(row.reserved_usd_micros,375);
  for(const privateId of [supplierRequestId,'synthetic_response'])assert.equal(JSON.stringify(initial.body).includes(privateId),false);
  const previousClocks=clocks;now=Date.parse('2026-10-15T02:00:00Z');const replay=await call();assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(upstreamCalls,1);assert.equal(lookupCount,2);assert.equal(clocks,previousClocks);
  const expired=port.discovery.read();assert.equal(expired.config.inferenceConfigured,false);assert.equal(expired.config.ready.chat,false);
  assert.deepEqual(expired.catalog.models,[]);
  assert.deepEqual(expired.v1Models.data,[]);assert.equal(upstreamCalls,1);
 }finally{await new Promise(r=>server.close(r));}
});

test('both conditional models have unique discovery entries and expire without hiding standard routes',()=>{
 let now=Date.parse('2026-10-08T02:00:00Z');
 const conditionalModels=['deepseek-v4-flash','deepseek-v4-pro'];
 const conditionalEntries=conditionalModels.map(model=>({...route,model,upstreamModel:model,supplierSlug:catalog.models.find(row=>row.model_name===model).primary.supplier_slug,supportsTools:true}));
 const standard={...route,model:'claude-fable-5',upstreamModel:'claude-fable-5',supplierSlug:'viapi'};
 const acceptedRates=Object.fromEntries(conditionalModels.map(model=>[model,{primary:{...rates['deepseek-v4-flash'].primary,supplierSlug:catalog.models.find(row=>row.model_name===model).primary.supplier_slug,currency:catalog.models.find(row=>row.model_name===model).primary.supplier_currency}}]));
 const servedVersions={'deepseek-v4-flash':'DeepSeek-V4.1-Flash','deepseek-v4-pro':'DeepSeek-V4-Pro-0813'};
 const port=createOwnedGatewayFromEnv({env:{...env,APIWILD_GATEWAY_ROUTES_JSON:JSON.stringify([...conditionalEntries,standard]),APIWILD_DEEPSEEK_TARIFF_POLICY_JSON:JSON.stringify({...policy,servedVersions}),APIWILD_DEEPSEEK_SUPPLIER_RATES_JSON:JSON.stringify(acceptedRates)},catalog,clock:()=>now,fetchImpl:()=>assert.fail('Discovery must not use transport.')});
 const active=port.discovery.read();assert.equal(active.catalog.models.filter(row=>row.callable).length,3);
 for(const id of conditionalModels){const rows=active.catalog.models.filter(row=>row.id===id);assert.equal(rows.length,1);assert.deepEqual(rows[0].capabilities,['chat']);assert.equal(rows[0].supportsTools,true);}
 for(const timestamp of ['2026-10-04T23:59:00Z','2026-10-11T23:59:00Z','2026-10-15T00:00:00Z']){
  now=Date.parse(timestamp);const current=port.discovery.read();assert.equal(current.config.ready.chat,true);
  assert.deepEqual(current.catalog.models.filter(row=>row.callable).map(row=>row.id),['claude-fable-5']);
  for(const id of conditionalModels){assert.equal(current.catalog.models.some(row=>row.id===id),false);assert.equal(current.config.models.some(row=>row.id===id),false);assert.equal(current.v1Models.data.some(row=>row.id===id),false);}
 }
});
