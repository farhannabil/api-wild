// SERVER ONLY: quote-based economics, never a customer DTO or supplier receipt.
import {GatewayError, exactInteger,strictObject} from './supabase-gateway-rpc.mjs';
import {isDeepSeekTierPolicy} from './deepseek-tier-policy.mjs';
const MICRO=1000000n;
const fail=()=>{throw new GatewayError('model_accounting_unverified');};
function decimal(value,places=6){
 const text=String(value);if(!/^\d+(?:\.\d+)?$/.test(text))fail();
 const [whole,fraction='']=text.split('.');if(fraction.length>places||Number(value)>1000000)fail();
 return BigInt(whole)*10n**BigInt(places)+BigInt(fraction.padEnd(places,'0'));
}
const ceil=(n,d)=>(n+d-1n)/d;
function safe(value){if(value>BigInt(Number.MAX_SAFE_INTEGER))fail();return Number(value);}
function tokenCost(input,output,prompt,completion){
 exactInteger(prompt,0,10000000);exactInteger(completion,0,10000000);
 return ceil(input*BigInt(prompt)+output*BigInt(completion),MICRO);
}
export function createModelAccounting({catalog,rateVersion,tierPolicy,conditionalSupplierRates={}}){
 if(!catalog||!Array.isArray(catalog.models)||typeof rateVersion!=='string'||!rateVersion||rateVersion.length>160)fail();
 if(tierPolicy!==undefined&&(!isDeepSeekTierPolicy(tierPolicy)||tierPolicy.baseRateVersion!==rateVersion))fail();
 strictObject(conditionalSupplierRates,['deepseek-v4-flash','deepseek-v4-pro']);
 for(const value of Object.values(conditionalSupplierRates))strictObject(value,['primary','backup']);
 // Pin FX to this quote snapshot. It is an estimate, not a settlement exchange rate.
 const fxScale=10n**18n,fx=decimal(catalog.fx?.CNY_USD,18);if(fx===0n)fail();
 const models=new Map();
 for(const model of catalog.models){
  const p=model.apiwild_selling_price;
  if(!p||p.approved!==true||p.currency!=='USD'||p.unit!=='per_million_tokens'||p.input_cache!=='uncached')fail();
  if(typeof model.model_name!=='string'||models.has(model.model_name)||!['standard','off_peak'].includes(p.processing))fail();
  const tiers=new Map([[p.processing,{input:decimal(p.input),output:decimal(p.output)}]]);
  if(p.peak)tiers.set('peak',{input:decimal(p.peak.input),output:decimal(p.peak.output)});
  const suppliers=new Map(),conditionalSuppliers=new Map();for(const role of ['primary','backup']){
   const s=model[role];if(!s)continue;
   if(s.unit!=='per_million_tokens'||s.billing_mode!=='ratio'||!['USD','CNY'].includes(s.supplier_currency))fail();
   suppliers.set(role,{slug:s.supplier_slug,currency:s.supplier_currency,input:decimal(s.supplier_input),output:decimal(s.supplier_output)});
   const accepted=conditionalSupplierRates[model.model_name]?.[role];
   if(accepted!==undefined){
    strictObject(accepted,['accepted','supplierSlug','currency','off_peak','peak']);
    if(accepted.accepted!==true||accepted.supplierSlug!==s.supplier_slug||accepted.currency!==s.supplier_currency)fail();
    const tiers=new Map();for(const tier of ['off_peak','peak']){strictObject(accepted[tier],['input','output']);tiers.set(tier,{slug:s.supplier_slug,currency:s.supplier_currency,input:decimal(accepted[tier].input),output:decimal(accepted[tier].output)});}
    conditionalSuppliers.set(role,tiers);
   }
  }
  if(!suppliers.has('primary'))fail();models.set(model.model_name,{tiers,suppliers,conditionalSuppliers,defaultTier:p.processing});
 }
 function quote({model,promptTokens,completionTokens,tier,supplier='primary'},override){
  const entry=models.get(model);if(!entry)fail();
  // Time-dependent prices require an explicit trusted tier; no silent off-peak assumption.
  if(tier===undefined){if(entry.defaultTier!=='standard')fail();tier='standard';}
  const retail=entry.tiers.get(tier),upstream=override??entry.suppliers.get(supplier);if(!retail||!upstream)fail();
  const retailUsd=tokenCost(retail.input,retail.output,promptTokens,completionTokens);
  const native=tokenCost(upstream.input,upstream.output,promptTokens,completionTokens);
  const usd=upstream.currency==='USD'?native:ceil(native*fx,fxScale);
  const cny=upstream.currency==='CNY'?native:ceil(native*fxScale,fx);
  return Object.freeze({model,rateVersion,tier,supplierSlug:upstream.slug,supplierCurrency:upstream.currency,
   retailUsdMicros:safe(retailUsd),estimatedSupplierNativeMicros:safe(native),estimatedSupplierUsdMicros:safe(usd),
   estimatedSupplierCnyMicros:safe(cny),estimatedGrossUsdMicros:safe(retailUsd)-safe(usd),supplierCostVerified:false});
 }
 const selectedSupplier=(model,supplier,tier)=>{const entry=models.get(model),rates=entry?.conditionalSuppliers.get(supplier);if(!rates)fail();return rates.get(tier);};
 return Object.freeze({models:Object.freeze([...models.keys()]),quote,
  conditionalReady:(model,supplier='primary')=>Boolean(tierPolicy?.models.includes(model)&&models.get(model)?.conditionalSuppliers.has(supplier)),
  quoteConditional({model,promptTokens,completionTokens,selection,supplier='primary'}){
   if(!tierPolicy)fail();tierPolicy.assertSelection(selection,model);
   const off=selectedSupplier(model,supplier,'off_peak'),peak=selectedSupplier(model,supplier,'peak');
   // A crossing horizon reserves the larger component ceiling, even if a
   // provider labels its peak quote unexpectedly lower than the off-peak one.
   const upstream=selection.reserveTier==='peak'?{...off,input:off.input>peak.input?off.input:peak.input,output:off.output>peak.output?off.output:peak.output}:off;
   return Object.freeze({...quote({model,promptTokens,completionTokens,tier:selection.tier,supplier},upstream),rateVersion:selection.rateVersion,reserveTier:selection.reserveTier});
  },
  quoteRecorded({model,promptTokens,completionTokens,requestRateVersion,supplier='primary'}){
   if(!tierPolicy)fail();const tier=tierPolicy.tierFromVersion(model,requestRateVersion),upstream=selectedSupplier(model,supplier,tier);
   return Object.freeze({...quote({model,promptTokens,completionTokens,tier,supplier},upstream),rateVersion:requestRateVersion});
  },
 });
}
