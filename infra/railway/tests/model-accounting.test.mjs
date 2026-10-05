import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createModelAccounting} from '../runtime/model-accounting.mjs';
const catalog=JSON.parse(await readFile(new URL('../../../data/selected-supplier-models.json',import.meta.url),'utf8'));
const make=()=>createModelAccounting({catalog,rateVersion:'fixture-v1'});
test('all 39 models have independent retail and private supplier calculations',()=>{
 const p=make();assert.equal(p.models.length,39);
 for(const m of catalog.models){for(const tier of [m.apiwild_selling_price.processing,...(m.apiwild_selling_price.peak?['peak']:[])]){
  const q=p.quote({model:m.model_name,promptTokens:1000000,completionTokens:1000000,tier});
  const r=tier==='peak'?m.apiwild_selling_price.peak:m.apiwild_selling_price;
  assert.equal(q.retailUsdMicros,Math.round((r.input+r.output)*1e6));assert.equal(q.supplierCostVerified,false);assert.ok(q.estimatedSupplierCnyMicros>0);
 }}
});
test('Fable preserves $30 retail and separate approximately $7.81 supplier cost',()=>{
 const q=make().quote({model:'claude-fable-5',promptTokens:1000000,completionTokens:1000000});
 assert.equal(q.retailUsdMicros,30000000);assert.equal(q.estimatedSupplierNativeMicros,52380000);assert.equal(q.estimatedSupplierUsdMicros,7812561);assert.equal(q.estimatedGrossUsdMicros,22187439);
});
test('mixed models use their own prices, not a universal 3.75 multiplier',()=>{
 const p=make(),a=p.quote({model:'claude-fable-5',promptTokens:500000,completionTokens:500000}),b=p.quote({model:'gpt-6-sol',promptTokens:1000000,completionTokens:1000000});
 assert.equal(30000000-a.retailUsdMicros-b.retailUsdMicros,9000000);assert.notEqual(b.retailUsdMicros,Math.round(b.estimatedSupplierUsdMicros*3.75));
});
test('zero, single token, invalid usage and unknown models',()=>{
 const p=make(),base={model:'claude-fable-5',promptTokens:0,completionTokens:0};assert.equal(p.quote(base).retailUsdMicros,0);assert.equal(p.quote({...base,promptTokens:1}).retailUsdMicros,5);
 for(const change of [{model:'unknown'},{promptTokens:-1},{completionTokens:0.5},{promptTokens:Number.MAX_SAFE_INTEGER},{tier:'batch'},{supplier:'unknown'}])assert.throws(()=>p.quote({...base,...change}));
});
test('time-dependent models require explicit trusted tier',()=>{
 const p=make(),q={model:'deepseek-v4-flash',promptTokens:1000000,completionTokens:1000000};assert.throws(()=>p.quote(q));assert.equal(p.quote({...q,tier:'off_peak'}).retailUsdMicros,375000);assert.equal(p.quote({...q,tier:'peak'}).retailUsdMicros,750000);
});
test('FX changes private estimate without changing customer tariff; snapshots are immutable',()=>{
 const c=structuredClone(catalog),p=createModelAccounting({catalog:c,rateVersion:'v1'}),q={model:'claude-fable-5',promptTokens:1000000,completionTokens:0};c.fx.CNY_USD=0.2;c.models.find(m=>m.model_name===q.model).primary.supplier_input=9;
 assert.equal(p.quote(q).estimatedSupplierNativeMicros,8730000);assert.equal(createModelAccounting({catalog:c,rateVersion:'v2'}).quote(q).retailUsdMicros,p.quote(q).retailUsdMicros);assert.notEqual(createModelAccounting({catalog:c,rateVersion:'v2'}).quote(q).estimatedSupplierUsdMicros,p.quote(q).estimatedSupplierUsdMicros);
});
