import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLiveness, assertModelCatalog, assertRuntimeConfig, waitForDeployment} from '../scripts/owned-health-contract.mjs';
import {readFile} from 'node:fs/promises';
import {createOwnedDiscoverySnapshot} from '../infra/railway/runtime/owned-discovery-http.mjs';

const commit='a'.repeat(40);
const model={id:'test-model',name:'Test model',creator:'Test',pricing:{currency:'USD',unit:'per_million_tokens',input:5,output:25},callable:false,capabilities:[],supportsTools:false,toolCapabilities:[]};
const catalog=()=>({schemaVersion:1,authority:'apiwild-owned-runtime',source:'apiwild-approved-retail',count:1,models:[structuredClone(model)]});
const config=()=>({schemaVersion:1,authority:'apiwild-owned-runtime',deploymentCommit:commit,enabled:false,inferenceConfigured:false,
  currency:'usd',rateVersion:'inactive',streaming:true,streamingMode:'buffered-after-settlement',functionCalling:true,nativeStreaming:false,externalTools:false,models:[structuredClone(model)],
  ready:{chat:false,code:false,research:false,voice:false,transcribe:false,speak:false}});
const fails=(fn,code)=>assert.throws(fn,error=>error.code===code);

test('healthy guarded runtime is distinct from paid launch readiness',()=>{
  assertLiveness({alive:true,ready:false,phase:'launch-preparation'});
  for(const value of [{alive:false,ready:false,phase:'launch-preparation'},{alive:true,ready:true,phase:'launch-preparation'},{alive:true,ready:false,phase:'legacy'}]) {
    fails(()=>assertLiveness(value),'INVALID_RUNTIME_LIVENESS');
  }
  assertRuntimeConfig(config(),assertModelCatalog(catalog()));
});

test('real approved retail catalog and owned discovery agree with health contract',async()=>{
  const source=JSON.parse(await readFile(new URL('../data/selected-supplier-models.json',import.meta.url),'utf8'));
  const snapshot=createOwnedDiscoverySnapshot({catalog:source,deploymentCommit:commit});
  const ids=assertModelCatalog(snapshot.catalog);assert.equal(ids.size,0);
  assertRuntimeConfig(snapshot.config,ids);
});

test('catalog rejects inconsistent counts, duplicate, private and unpriced model data',()=>{
  const changes=[
    [c=>{c.models=[];c.count=1;},'INVALID_OWNED_CATALOG'],
    [c=>{c.models.push(structuredClone(model));c.count=2;},'INVALID_CATALOG_MODEL'],
    [c=>{c.models[0].primary={supplier_input:1};},'PRIVATE_RUNTIME_FIELD'],
    [c=>{c.models[0].name='sb_secret_do_not_publish';},'PRIVATE_RUNTIME_VALUE'],
    [c=>{c.models[0].pricing.currency='CNY';},'INVALID_RETAIL_PRICE'],
    [c=>{c.models[0].pricing.output=-1;},'INVALID_RETAIL_PRICE'],
    [c=>{c.models[0].callable=true;},'INVALID_MODEL_AVAILABILITY'],
  ];
  for(const [mutate,code]of changes){const value=catalog();mutate(value);fails(()=>assertModelCatalog(value),code);}
});

test('availability must agree with catalog and actual configured capabilities',()=>{
  const ids=assertModelCatalog(catalog());
  for(const deploymentCommit of [null,'main','short']){const value=config();value.deploymentCommit=deploymentCommit;fails(()=>assertRuntimeConfig(value,ids),'INVALID_OWNED_RUNTIME');}
  const wrongCatalog=config();wrongCatalog.models[0].id='other';fails(()=>assertRuntimeConfig(wrongCatalog,ids),'CATALOG_CONFIG_MISMATCH');
  const falseReady=config();falseReady.ready.chat=true;fails(()=>assertRuntimeConfig(falseReady,ids),'INVALID_CAPABILITY_AVAILABILITY');
  const falseEnabled=config();falseEnabled.enabled=true;falseEnabled.inferenceConfigured=true;fails(()=>assertRuntimeConfig(falseEnabled,ids),'INVALID_INFERENCE_AVAILABILITY');
  const callable=config();callable.enabled=true;callable.inferenceConfigured=true;callable.models[0].callable=true;callable.models[0].capabilities=['chat'];callable.ready.chat=true;
  assertRuntimeConfig(callable,ids);
});

test('deployment polling waits through old release and transient outage for exact commit',async()=>{
  let clock=0,calls=0;const urls=[];
  const request=async(url)=>{urls.push(url);calls++;return calls===1?new Response('{}',{status:503}):Response.json({...config(),deploymentCommit:calls===2?'b'.repeat(40):commit});};
  await waitForDeployment({site:'https://apiwild.com',expectedCommit:commit,timeoutMs:30,intervalMs:10,request,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  assert.equal(calls,3);assert.equal(clock,20);assert.ok(urls.every(url=>url==='https://apiwild.com/api/gateway/config'));
});

test('final route assertion rejects a deployment change after the initial wait',()=>{
  const ids=assertModelCatalog(catalog());
  assertRuntimeConfig(config(),ids,commit);
  fails(()=>assertRuntimeConfig({...config(),deploymentCommit:'b'.repeat(40)},ids,commit),'EXPECTED_DEPLOYMENT_NOT_ACTIVE');
  fails(()=>assertRuntimeConfig(config(),ids,'main'),'INVALID_EXPECTED_COMMIT');
});

test('wrong, missing or malformed deployment identity remains a failing release gate',async()=>{
  for(const value of [{...config(),deploymentCommit:'b'.repeat(40)},{...config(),deploymentCommit:null},{...config(),authority:'legacy'}]){
    await assert.rejects(waitForDeployment({site:'https://apiwild.com',expectedCommit:commit,timeoutMs:0,request:async()=>Response.json(value)}),error=>error.code==='EXPECTED_DEPLOYMENT_NOT_ACTIVE');
  }
  await assert.rejects(waitForDeployment({site:'https://apiwild.com',expectedCommit:'main',request:async()=>{throw Error('Should not fetch');}}),error=>error.code==='INVALID_EXPECTED_COMMIT');
});
