import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createRetailTokenPricing} from '../runtime/retail-token-pricing.mjs';
import {canonicalSupplierModel} from '../runtime/supplier-model-identity.mjs';
import {createDeepSeekTierPolicy,DEEPSEEK_SOURCE_REVISION,DEEPSEEK_CALENDAR_VERSION} from '../runtime/deepseek-tier-policy.mjs';
import {nativeTariffCharge} from '../runtime/native-retail-tier.mjs';
import {nativeRateSnapshot,nativeAllowance} from '../runtime/native-customer-keys.mjs';
import {listedCustomerModels} from '../../../app/models/callable-catalogue.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../../../app/models/public-models.json',import.meta.url)));
const metadata=JSON.parse(fs.readFileSync(new URL('../../../app/models/public-model-metadata.json',import.meta.url)));
const version='apiwild-launch-20261005',ds='deepseek-v4.1-flash';
const config={accepted:true,billingBasis:'apiwild_admission_time',baseRateVersion:version,sourceRevision:DEEPSEEK_SOURCE_REVISION,calendarVersion:DEEPSEEK_CALENDAR_VERSION,validFrom:'2026-10-12T00:00:00.000Z',validUntil:'2026-11-04T10:25:19.000Z',servedVersions:{[ds]:'DeepSeek-V4.1-Flash'}};
test('six owner prices, immutable model versions and complete metadata agree',()=>{
 const p=createRetailTokenPricing({models:catalog.models,rateVersion:version});
 for(const[id,input,output]of [['gpt-6-astra',5,25],['gpt-6-sol',1,5],['glm-5.3',1,2.25],['claude-sonnet-5-5',1,5],['gemini-3.8-flash',.5,1.75]]){
  const row=catalog.models.find(m=>m.model_name===id);assert.equal(row.apiwild_selling_price.input,input);assert.equal(row.apiwild_selling_price.output,output);
  assert.equal(p.charge({model:id,promptTokens:1000000,completionTokens:1000000}).costUsdMicros,(input+output)*1000000);
  assert.equal(p.versionFor(id),version+':models26');assert.throws(()=>p.charge({model:id,promptTokens:1,completionTokens:1,requestRateVersion:version}));assert.ok(metadata[id].description);
 }
 assert.equal(p.charge({model:'gpt-6-astra',promptTokens:4392,completionTokens:5}).costUsdMicros,22085);
 assert.equal(p.charge({model:'gpt-6-sol',promptTokens:4392,completionTokens:5}).costUsdMicros,4417);
 assert.ok(metadata[ds].description);assert.ok(!JSON.stringify(catalog).includes('supplier_input'));
});
test('reviewed supplier aliases are accepted only for the exact model and supplier',()=>{
 const identity={model:ds,supplierSlug:'a6aa'};assert.equal(canonicalSupplierModel('cb/'+ds,identity),ds);
 for(const patch of [{supplierSlug:'kriora'},{model:'deepseek-v4-flash'},{model:'gpt-6-sol'},{upstreamModel:'other'}])assert.equal(canonicalSupplierModel('cb/'+ds,{...identity,...patch}),null);
 for(const value of ['other/'+ds,'cb/deepseek-v4-flash',null])assert.equal(canonicalSupplierModel(value,identity),null);
 for(const [value,alias] of [['grok-4.5-build',{model:'grok-4.5',supplierSlug:'viapi'}],['gemini-3.8-flash-high',{model:'gemini-3.8-flash',supplierSlug:'a6aa'}]]){
  assert.equal(canonicalSupplierModel(value,alias),alias.model);
  for(const patch of [{supplierSlug:'other'},{model:'other'}])assert.equal(canonicalSupplierModel(value,{...alias,...patch}),null);
 }
});
test('DeepSeek tier is pinned across boundaries and prices equal the owner decision',()=>{
 let time=Date.parse('2026-10-13T00:59:59.000Z');const policy=createDeepSeekTierPolicy({enabled:true,config,clock:()=>time}),p=createRetailTokenPricing({models:catalog.models,rateVersion:version,tierPolicy:policy});
 const original=policy.select(ds);assert.equal(original.tier,'off_peak');time=Date.parse('2026-10-13T01:00:00.000Z');
 assert.equal(p.charge({model:ds,promptTokens:1000000,completionTokens:1000000,requestRateVersion:original.rateVersion}).costUsdMicros,440000);
 assert.equal(p.charge({model:ds,promptTokens:1000000,completionTokens:1000000,requestRateVersion:policy.select(ds).rateVersion}).costUsdMicros,910000);
});
test('hourly native retail uses receipt UTC time, preserves old fixed snapshots and rejects expired calendar',()=>{
 const rates={[ds]:{input:90000,output:350000,processing:'off_peak',peak:{input:150000,output:760000},calendar:DEEPSEEK_CALENDAR_VERSION,validFrom:Date.parse(config.validFrom)/1000,validUntil:Date.parse(config.validUntil)/1000},old:{input:1000000,output:5000000}};
 const f={model:ds,prompt:1000000,completion:1000000};
 for(const[date,cost]of [['2026-10-13T01:00:00Z',910000],['2026-10-13T04:00:00Z',440000],['2026-10-17T02:00:00Z',440000]])assert.equal(nativeTariffCharge({...f,created:Date.parse(date)/1000},rates),cost);
 assert.equal(nativeTariffCharge({...f,model:'old',created:Date.parse('2026-10-13T02:00:00Z')/1000},rates),6000000);
 assert.throws(()=>nativeTariffCharge({...f,created:Date.parse(config.validUntil)/1000},rates));
 for(const patch of [{validFrom:undefined},{validUntil:undefined},{validFrom:null},{validUntil:NaN},{calendar:undefined},{validUntil:rates[ds].validFrom}])assert.throws(()=>nativeTariffCharge({...f,created:Date.parse('2026-10-13T02:00:00Z')/1000},{[ds]:{...rates[ds],...patch}}));
});
test('cards list approved prices without falsely granting callability',()=>{
 const rows=listedCustomerModels({schemaVersion:1,authority:'apiwild-owned-runtime',source:'apiwild-approved-retail',count:1,models:[{id:'gpt-6-astra',callable:true,capabilities:['chat']}]},catalog.models);
 assert.equal(rows.length,22);assert.equal(rows.find(m=>m.model_name==='gpt-6-astra').available,true);assert.equal(rows.find(m=>m.model_name===ds).available,false);
});
test('native six-model snapshot admits reviewed DeepSeek policy and reserves its peak tariff',()=>{
 const privateCatalog=JSON.parse(fs.readFileSync(new URL('../../../data/selected-supplier-models.json',import.meta.url)));
 const models=['gpt-6-astra','gpt-6-sol','glm-5.3','claude-sonnet-5-5','gemini-3.8-flash',ds];
 const routes=models.map(model=>({model,supplierSlug:'a6aa'}));
 const tierPolicy=createDeepSeekTierPolicy({enabled:true,config,clock:()=>Date.parse('2026-10-13T00:00:00Z')});
 const rates=nativeRateSnapshot(privateCatalog,routes,{tierPolicy});assert.equal(Object.keys(rates).length,6);
 assert.equal(rates[ds].peak.output,760000);assert.equal(rates[ds].validUntil,Date.parse(config.validUntil)/1000);assert.ok(nativeAllowance(100000,rates).quota>0);
 assert.throws(()=>nativeRateSnapshot(privateCatalog,routes));
});
