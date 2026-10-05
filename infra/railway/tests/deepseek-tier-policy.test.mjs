import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDeepSeekTierPolicy,deepSeekCalendarTier,DEEPSEEK_SOURCE_REVISION,DEEPSEEK_CALENDAR_VERSION} from '../runtime/deepseek-tier-policy.mjs';
import {createRetailTokenPricing} from '../runtime/retail-token-pricing.mjs';
import {createModelAccounting} from '../runtime/model-accounting.mjs';
const catalog=JSON.parse(await readFile(new URL('../../../data/selected-supplier-models.json',import.meta.url),'utf8'));
const baseRateVersion='catalog-fixture-ds-policy-20261005';
const config={accepted:true,billingBasis:'apiwild_admission_time',baseRateVersion,sourceRevision:DEEPSEEK_SOURCE_REVISION,
  calendarVersion:DEEPSEEK_CALENDAR_VERSION,validFrom:'2026-10-05T00:00:00.000Z',validUntil:'2026-10-12T00:00:00.000Z',
  servedVersions:{'deepseek-v4-flash':'DeepSeek-V4.1-Flash','deepseek-v4-pro':'DeepSeek-V4-Pro-0813'}};
const tier=date=>deepSeekCalendarTier(Date.parse(date));
const make=(date='2026-10-08T02:00:00Z',patch={})=>createDeepSeekTierPolicy({enabled:true,config:{...config,...patch},clock:()=>Date.parse(date)});
const model='deepseek-v4-flash';
const conditionalSupplierRates=Object.fromEntries(catalog.models.filter(m=>m.model_name.startsWith('deepseek')).map(m=>[m.model_name,{
  primary:{accepted:true,supplierSlug:m.primary.supplier_slug,currency:m.primary.supplier_currency,
    off_peak:{input:m.primary.supplier_input,output:m.primary.supplier_output},peak:{input:m.primary.supplier_input*2,output:m.primary.supplier_output*2}}
}])); // synthetic accepted test tariff, never a supplier price claim

test('UTC peak boundaries use half-open intervals in Beijing business days',()=>{
  for(const [at,want] of [['00:59:59.999','off_peak'],['01:00:00.000','peak'],['03:59:59.999','peak'],['04:00:00.000','off_peak'],
    ['05:59:59.999','off_peak'],['06:00:00.000','peak'],['09:59:59.999','peak'],['10:00:00.000','off_peak']])assert.equal(tier('2026-10-08T'+at+'Z'),want);
});
test('official holidays and all weekends are off-peak, including makeup weekends',()=>{
  for(const date of ['2026-01-01','2026-02-16','2026-04-06','2026-05-04','2026-06-19','2026-09-25','2026-10-05','2026-10-07',
    '2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10','2026-10-11'])assert.equal(tier(date+'T02:00:00Z'),'off_peak',date);
  assert.equal(tier('2026-10-08T02:00:00Z'),'peak');
});
test('calendar and accepted price window expire closed; no unknown year guess',()=>{
  assert.throws(()=>tier('2027-01-04T02:00:00Z'));
  assert.throws(()=>make('2026-10-12T00:00:00Z').select(model));
  assert.throws(()=>make('2026-10-04T23:59:59Z').select(model));
  assert.throws(()=>make('2026-10-11T23:59:50Z').select(model,25000));
});
test('explicit admission policy, calendar/source versions and exact served version are required',()=>{
  assert.equal(createDeepSeekTierPolicy(),undefined);
  for(const patch of [{accepted:false},{billingBasis:'supplier_request_finish'},{sourceRevision:'unknown'},
    {calendarVersion:'guess2027'},{servedVersions:{[model]:'DeepSeek-V4-Flash'}},{validUntil:'2027-01-01T00:00:00.000Z'}])assert.throws(()=>make(undefined,patch));
});

test('nonspending availability follows the same finite admission window without selecting a tariff',()=>{
  let now=Date.parse('2026-10-08T00:59:50Z');const policy=createDeepSeekTierPolicy({enabled:true,config,clock:()=>now});
  assert.equal(policy.canAdmit(model),true);assert.equal(policy.canAdmit('unknown-model'),false);
  for(const horizon of [0,120001,NaN,'25000'])assert.equal(policy.canAdmit(model,horizon),false);
  for(const value of [Date.parse('2026-10-04T23:59:59Z'),Date.parse('2026-10-12T00:00:00Z'),NaN,'2026-10-08']){
    now=value;assert.equal(policy.canAdmit(model),false);assert.throws(()=>policy.select(model));
  }
  now=Date.parse('2026-10-11T23:57:59.999Z');assert.equal(policy.canAdmit(model),true);
  now=Date.parse('2026-10-11T23:58:00.000Z');assert.equal(policy.canAdmit(model),false);assert.throws(()=>policy.select(model));
  assert.equal(policy.canAdmit(model,25000),true);
  const failedClock=createDeepSeekTierPolicy({enabled:true,config,clock:()=>{throw Error('clock unavailable');}});assert.equal(failedClock.canAdmit(model),false);
});
test('trusted clock selects tier once and reservation spans a peak boundary',()=>{
  let now=Date.parse('2026-10-08T00:59:50Z');const policy=createDeepSeekTierPolicy({enabled:true,config,clock:()=>now});
  const quote=policy.select(model,25000);assert.equal(quote.tier,'off_peak');assert.equal(quote.reserveTier,'peak');
  now=Date.parse('2026-10-08T01:00:10Z');assert.equal(policy.tierFromVersion(model,quote.rateVersion),'off_peak');
  assert.equal(policy.select(model,25000).tier,'peak');assert.throws(()=>policy.assertSelection({...quote},model));
  assert.throws(()=>make().assertSelection(quote,model));
});
test('unaccepted conditional models stay outside the standard 37 tariffs',()=>{
  assert.equal(createRetailTokenPricing({models:catalog.models,rateVersion:baseRateVersion}).models.length,37);
  const policy=make();const prices=createRetailTokenPricing({models:catalog.models,rateVersion:baseRateVersion,tierPolicy:policy});
  assert.equal(prices.models.length,39);
  assert.throws(()=>prices.charge({model,promptTokens:1,completionTokens:1}));
  for(const version of [baseRateVersion+':ds26:peak:extra',baseRateVersion+':ds27:peak','foreign:ds26:peak'])
    assert.throws(()=>prices.charge({model,promptTokens:1,completionTokens:1,requestRateVersion:version}));
});
test('settlement charges the frozen recorded tier even after a boundary',()=>{
  let now=Date.parse('2026-10-08T00:59:50Z');const policy=createDeepSeekTierPolicy({enabled:true,config,clock:()=>now});
  const pricing=createRetailTokenPricing({models:catalog.models,rateVersion:baseRateVersion,tierPolicy:policy}),quote=policy.select(model,25000);
  const input={model,promptTokens:1000000,completionTokens:1000000,requestRateVersion:quote.rateVersion};
  assert.equal(pricing.charge(input).costUsdMicros,375000);now=Date.parse('2026-10-08T01:00:10Z');assert.equal(pricing.charge(input).costUsdMicros,375000);
  assert.equal(pricing.charge({...input,requestRateVersion:policy.select(model,25000).rateVersion}).costUsdMicros,750000);
});
test('conditional supplier reserve requires accepted exact provider tiers, never the retail multiplier',()=>{
  const policy=make('2026-10-08T00:59:50Z'),selection=policy.select(model,25000);
  const noSupplier=createModelAccounting({catalog,rateVersion:baseRateVersion,tierPolicy:policy});assert.equal(noSupplier.conditionalReady(model),false);
 assert.throws(()=>createModelAccounting({catalog,rateVersion:baseRateVersion,tierPolicy:policy,conditionalSupplierRates:{[model]:{unknown:{accepted:true}}}}));
  assert.throws(()=>noSupplier.quoteConditional({model,promptTokens:1000000,completionTokens:1000000,selection}));
  const accounting=createModelAccounting({catalog,rateVersion:baseRateVersion,tierPolicy:policy,conditionalSupplierRates});
  const reserve=accounting.quoteConditional({model,promptTokens:1000000,completionTokens:1000000,selection});
  assert.equal(reserve.retailUsdMicros,375000);assert.equal(reserve.estimatedSupplierNativeMicros,500000);assert.equal(reserve.supplierCostVerified,false);
  assert.equal(reserve.reserveTier,'peak');assert.equal(reserve.rateVersion,selection.rateVersion);
  const settled=accounting.quoteRecorded({model,promptTokens:1000000,completionTokens:1000000,requestRateVersion:selection.rateVersion});
  assert.equal(settled.retailUsdMicros,375000);assert.equal(settled.supplierCostVerified,false);
});
test('standard models retain exact versions and immutable rates',()=>{
  const policy=make(),p=createRetailTokenPricing({models:catalog.models,rateVersion:baseRateVersion,tierPolicy:policy});
  const input={model:'claude-fable-5',promptTokens:1000000,completionTokens:1000000};assert.equal(p.charge(input).costUsdMicros,30000000);
  assert.throws(()=>p.charge({...input,requestRateVersion:baseRateVersion+':ds26:peak'}));
});
