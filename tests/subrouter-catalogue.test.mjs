import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeCatalogue,fetchPublicCatalogue,createCatalogueLoader,PUBLIC_ORIGIN} from '../lib/subrouter-catalogue.mjs';

const fetchedAt='2026-10-04T22:33:32.673Z';
function fixture({providerCount=1}={}) {
 const providers=Array.from({length:providerCount},(_,index)=>({id:index+1,slug:`supplier-${index+1}`,company_name:`Supplier ${index+1}`}));
 const names=Array.from({length:12},(_,index)=>`creator/model-${index}`);
 const pricing={success:true,vendors:[{id:3,name:'Creator'}],data:[...names,'index-only','image-model','audio-model','video-model','embed-model','tiered-model'].map(model_name=>({model_name,vendor_id:3,model_ratio:999,model_price:0,supported_endpoint_types:['openai']}))};
 let offerId=1;
 const details=providers.map(provider=>{
  const base={provider_id:provider.id,status:1,is_public:true,upstream_model:'upstream-alias',category:'chat',context_length:8192,endpoints:'{"openai":{"path":"/v1/chat/completions","method":"POST"}}',price_currency:'CNY',billing_mode:'ratio',input_price:0.5,output_price:2.5,fixed_price:0,cache_read_price:null,pricing_authoritative:false,probe_results:{platform:{status:'passed',verdict:'reported',details:'raw test transcript'}}};
  const models=names.map(model_name=>({...base,id:offerId++,model_name}));
  models.push({...base,id:offerId++,model_name:'image-model',category:'image',billing_mode:'per_call',input_price:0,output_price:0,fixed_price:0.04});
  models.push({...base,id:offerId++,model_name:'audio-model',category:'text-to-speech'});
  models.push({...base,id:offerId++,model_name:'video-model',category:'image-to-video'});
  models.push({...base,id:offerId++,model_name:'embed-model',category:'embedding'});
  models.push({...base,id:offerId++,model_name:'tiered-model',price_currency:'USD',billing_mode:'tiered_expr',input_price:0,output_price:0,billing_expr:'globalThis.notAllowed = true; p * 0.90'});
  return {success:true,data:{provider,models,public_model_count:models.length,filtered_model_count:models.length}};
 });
 return {pricing,providers,details};
}
function normalized(input=fixture()){return normalizeCatalogue(input.pricing,input.providers,input.details,fetchedAt);}
function fakeFetch(input,{failPath=null,mutatePage=null}={}) {
 const calls=[];
 async function run(url,options) {
  calls.push({url,options});const parsed=new URL(url);
  if(parsed.pathname===failPath)throw new Error('Synthetic failure');
  let body;
  if(parsed.pathname==='/api/pricing')body=input.pricing;
  else if(parsed.pathname==='/api/marketplace/providers') {
   const page=Number(parsed.searchParams.get('page')??1);
   body={success:true,total:input.providers.length,data:input.providers.slice((page-1)*100,page*100)};
   if(mutatePage)body=mutatePage(body,page,calls);
  } else body=input.details.find(detail=>parsed.pathname===`/api/marketplace/providers/${detail.data.provider.slug}`);
  assert.ok(body,'No undocumented endpoint should be fetched');
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
 }
 return {run,calls};
}

test('complete union retains more than ten names and every supplier offer',()=>{
 const data=normalized(fixture({providerCount:2}));
 assert.equal(data.count,18);assert.equal(data.subrouter.offerCount,34);assert.equal(data.subrouter.marketplaceModelCount,17);assert.equal(data.subrouter.pricingOnlyCount,1);
 assert.equal(data.models.find(model=>model.id==='creator/model-1').subrouter.offers.length,2);
 assert.equal(data.models.find(model=>model.id==='creator/model-1').providerName,'Creator');
 assert.equal(data.models.find(model=>model.id==='creator/model-1').subrouter.offers[0].providerName,'Supplier 1');
 assert.equal(data.models.find(model=>model.id==='creator/model-1').subrouter.offers[0].upstreamModel,'upstream-alias');
});
test('supplier-only model names are retained with unknown creator rather than invented aliases',()=>{
 const input=fixture();input.details[0].data.models[0].model_name='unindexed-Suffix-Exact';
 const data=normalized(input);assert.ok(data.models.some(model=>model.id==='unindexed-Suffix-Exact'));
 assert.equal(data.models.find(model=>model.id==='unindexed-Suffix-Exact').providerName,'Unknown creator');
 assert.equal(data.subrouter.pricingOnlyCount,2);
});
test('index ratios and zero placeholders never become supplier token costs or free models',()=>{
 const data=normalized();const only=data.models.find(model=>model.id==='index-only');
 assert.equal(only.subrouter.offers.length,0);assert.deepEqual(only.pricing,{input:null,output:null});assert.equal(only.pricingUnresolved,true);
 const image=data.models.find(model=>model.id==='image-model').subrouter.offers[0];
 assert.equal(image.fixedPrice,'0.04');assert.equal(image.billingMode,'per_call');assert.equal(image.inputPrice,'0');
 assert.deepEqual(data.models.find(model=>model.id==='image-model').displayPricing,[]);
});
test('currency and per-million quotes remain unchanged and nullable cache is unknown',()=>{
 const data=normalized();const offer=data.models.find(model=>model.id==='creator/model-1').subrouter.offers[0];
 assert.equal(offer.currency,'CNY');assert.equal(offer.inputPrice,'0.5');assert.equal(offer.outputPrice,'2.5');assert.equal(offer.cachePrices.read,null);
 assert.equal(data.models.find(model=>model.id==='tiered-model').subrouter.offers[0].currency,'USD');
});
test('formulas and endpoint paths remain inert, including executable-looking text',()=>{
 delete globalThis.notAllowed;
 const input=fixture();input.details[0].data.models[0].endpoints='{"openai":{"path":"https://evil.example/steal","method":"POST"}}';
 const data=normalized(input);
 assert.equal(data.models.find(model=>model.id==='tiered-model').subrouter.offers[0].billingExpression,'globalThis.notAllowed = true; p * 0.90');
 assert.equal(globalThis.notAllowed,undefined);
 assert.equal(data.models.find(model=>model.id==='creator/model-0').subrouter.offers[0].endpoints[0].path,'https://evil.example/steal');
});
test('platform reports never certify station listing, customer access or API WILD tests',()=>{
 const offer=normalized().models.find(model=>model.id==='creator/model-1').subrouter.offers[0];
 assert.equal(offer.stationListed,'unknown');assert.equal(offer.callable,false);assert.equal(offer.tested,'not-run');
 assert.equal(offer.platformEvidence.probe_summaries.platform.status,'passed');
 assert.equal(offer.platformEvidence.probe_summaries.platform.details,undefined);
});
test('all observed modality families are retained without guessing index-only capability',()=>{
 const models=normalized().models;
 for(const [name,capability] of [['image-model','image'],['audio-model','speech'],['video-model','video'],['embed-model','embeddings']])assert.ok(models.find(model=>model.id===name).output.includes(capability));
 assert.deepEqual(models.find(model=>model.id==='index-only').output,['unknown']);
});
test('malformed interfaces and missing optional fields do not crash display normalization',()=>{
 const input=fixture();input.details[0].data.models[0].endpoints='broken';delete input.details[0].data.models[0].upstream_model;
 const offer=normalized(input).models.find(model=>model.id==='creator/model-0').subrouter.offers[0];
 assert.equal(offer.endpointParseError,true);assert.deepEqual(offer.endpoints,[]);assert.equal(offer.upstreamModel,'');
});
test('duplicate identical offers are deduplicated; conflicting identities fail closed',()=>{
 const input=fixture();const detail=input.details[0].data;
 detail.models.push({...detail.models[0]});detail.public_model_count++;detail.filtered_model_count++;
 assert.equal(normalized(input).subrouter.offerCount,17);
 detail.models.at(-1).output_price=500;assert.throws(()=>normalized(input),/Conflicting offer/);
});
test('missing suppliers, mismatched counts and conflicting index identities reject publication',()=>{
 const missing=fixture({providerCount:2});missing.details.pop();assert.throws(()=>normalized(missing),/Missing supplier/);
 const truncated=fixture();truncated.details[0].data.public_model_count++;assert.throws(()=>normalized(truncated),/Incomplete supplier model count/);
 const conflict=fixture();conflict.pricing.data.push({...conflict.pricing.data[0],vendor_id:77});assert.throws(()=>normalized(conflict),/Conflicting pricing model/);
});
test('paged full public fetch has fixed host, no credentials, no redirects and no paid endpoint',async()=>{
 const input=fixture({providerCount:101}), fake=fakeFetch(input);
 const data=await fetchPublicCatalogue(fake.run,{now:()=>Date.parse(fetchedAt)});
 assert.equal(data.subrouter.providerCount,101);assert.equal(data.subrouter.offerCount,1717);
 assert.ok(fake.calls.some(call=>call.url.includes('page=2')));
 for(const call of fake.calls){assert.equal(new URL(call.url).origin,PUBLIC_ORIGIN);assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');assert.equal(call.options.method,'GET');assert.deepEqual(call.options.headers,{Accept:'application/json'});}
});
test('no-progress pagination and total churn are rejected instead of truncating',async()=>{
 const input=fixture({providerCount:101});
 const overlap=fakeFetch(input,{mutatePage:(body,page)=>page===2?{...body,data:input.providers.slice(0,100)}:body});
 await assert.rejects(fetchPublicCatalogue(overlap.run),/Incomplete provider pagination/);
 const churn=fakeFetch(input,{mutatePage:(body,page)=>page===2?{...body,total:102}:body});
 await assert.rejects(fetchPublicCatalogue(churn.run),/Provider total changed/);
});
test('unsafe source slugs never become fetch targets',async()=>{
 const input=fixture();input.providers[0].slug='../secret';input.details[0].data.provider.slug='../secret';
 const fake=fakeFetch(input);await assert.rejects(fetchPublicCatalogue(fake.run),/Unsafe provider slug/);
 assert.equal(fake.calls.length,2);
});
test('partial failure preserves complete generation, original timestamp and bounded retry backoff',async()=>{
 const bootstrap=normalized();let now=Date.parse(fetchedAt)+700000;
 const fake=fakeFetch(fixture(),{failPath:'/api/pricing'});
 const load=createCatalogueLoader({bootstrap,fetchImpl:fake.run,now:()=>now,waitForRefresh:true});
 const stale=await load();assert.equal(stale.count,18);assert.equal(stale.fetchedAt,fetchedAt);assert.equal(stale.subrouter.stale,true);assert.match(stale.subrouter.refreshError,/retaining/);
 const requests=fake.calls.length;await load();assert.equal(fake.calls.length,requests);
 now+=60001;await load();assert.ok(fake.calls.length>requests);
});
test('concurrent refreshes are single-flight and successful complete refresh replaces stale generation',async()=>{
 const bootstrap=normalized();const fake=fakeFetch(fixture());const now=Date.parse(fetchedAt)+700000;
 const load=createCatalogueLoader({bootstrap,fetchImpl:fake.run,now:()=>now,waitForRefresh:true});
 const [a,b,c]=await Promise.all([load(),load(),load()]);assert.equal(a,b);assert.equal(b,c);assert.equal(fake.calls.length,4);assert.equal(a.subrouter.stale,false);assert.equal(a.fetchedAt,new Date(now).toISOString());
});
test('timeout retains bundled last-known-good snapshot after restart',async()=>{
 const bootstrap=normalized();const load=createCatalogueLoader({bootstrap,now:()=>Date.parse(fetchedAt)+700000,timeoutMs:5,waitForRefresh:true,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Synthetic timeout')),{once:true}))});
 const stale=await load();assert.equal(stale.count,18);assert.equal(stale.subrouter.stale,true);assert.equal(stale.fetchedAt,fetchedAt);
});
test('oversized or malformed public responses cannot replace a complete catalogue',async()=>{
 const bootstrap=normalized();
 for(const response of [()=>new Response('{}',{headers:{'Content-Length':'10000001'}}),()=>new Response('not json')]){
  const load=createCatalogueLoader({bootstrap,now:()=>Date.parse(fetchedAt)+700000,waitForRefresh:true,fetchImpl:async()=>response()});
  const data=await load();assert.equal(data.count,18);assert.equal(data.subrouter.stale,true);
 }
});
test('bundled complete public generation has independent counts and fail-closed authority',()=>{
 const data=JSON.parse(readFileSync(new URL('../data/subrouter-catalogue.json',import.meta.url),'utf8'));
 assert.equal(data.count,data.models.length);assert.equal(data.count,1356);assert.equal(data.subrouter.offerCount,1565);assert.equal(data.subrouter.marketplaceModelCount,504);assert.equal(data.subrouter.pricingOnlyCount,852);
 const offers=data.models.flatMap(model=>model.subrouter.offers);assert.equal(new Set(offers.map(offer=>offer.id)).size,offers.length);
 assert.ok(offers.every(offer=>offer.callable===false&&offer.tested==='not-run'&&offer.stationListed==='unknown'));
});
test('customer requests immediately retain complete stale data while a single background scan runs',async()=>{
 const bootstrap=normalized(),fake=fakeFetch(fixture());let release;
 const gate=new Promise(resolve=>release=resolve);
 const load=createCatalogueLoader({bootstrap,now:()=>Date.parse(fetchedAt)+700000,fetchImpl:async(...args)=>{await gate;return fake.run(...args)}});
 const a=await load(),b=await load();assert.equal(a,b);assert.equal(a.count,18);assert.equal(a.subrouter.stale,true);assert.equal(a.fetchedAt,fetchedAt);
 release();await new Promise(setImmediate);await new Promise(setImmediate);
 const current=await load();assert.equal(current.subrouter.stale,false);assert.equal(fake.calls.length,4);
});
test('inactive or non-public source rows reject the generation without being advertised',()=>{
 for(const field of ['status','is_public']){
  const input=fixture();input.details[0].data.models[0][field]=field==='status'?0:false;
  assert.throws(()=>normalized(input),/not declared active and public/);
 }
});
test('invalid structured endpoints are flagged and feature metadata is retained as reported only',()=>{
 const input=fixture();input.details[0].data.models[0].endpoints='{"openai":{}}';input.details[0].data.models[0].features={tools:true,reasoning:true};
 const model=normalized(input).models.find(model=>model.id==='creator/model-0');
 assert.equal(model.subrouter.offers[0].endpointParseError,true);
 assert.deepEqual(model.subrouter.offers[0].reportedFeatures,{tools:true,reasoning:true});
 assert.deepEqual(model.parameters,[]);assert.equal(model.subrouter.offers[0].callable,false);
});
