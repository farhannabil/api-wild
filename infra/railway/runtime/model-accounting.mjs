// SERVER ONLY: quote-based economics, never a customer DTO or supplier receipt.
import {GatewayError, exactInteger} from './supabase-gateway-rpc.mjs';
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
export function createModelAccounting({catalog,rateVersion}){
 if(!catalog||!Array.isArray(catalog.models)||typeof rateVersion!=='string'||!rateVersion||rateVersion.length>160)fail();
 // Pin FX to this quote snapshot. It is an estimate, not a settlement exchange rate.
 const fxScale=10n**18n,fx=decimal(catalog.fx?.CNY_USD,18);if(fx===0n)fail();
 const models=new Map();
 for(const model of catalog.models){
  const p=model.apiwild_selling_price;
  if(!p||p.approved!==true||p.currency!=='USD'||p.unit!=='per_million_tokens'||p.input_cache!=='uncached')fail();
  if(typeof model.model_name!=='string'||models.has(model.model_name)||!['standard','off_peak'].includes(p.processing))fail();
  const tiers=new Map([[p.processing,{input:decimal(p.input),output:decimal(p.output)}]]);
  if(p.peak)tiers.set('peak',{input:decimal(p.peak.input),output:decimal(p.peak.output)});
  const suppliers=new Map();for(const role of ['primary','backup']){
   const s=model[role];if(!s)continue;
   if(s.unit!=='per_million_tokens'||s.billing_mode!=='ratio'||!['USD','CNY'].includes(s.supplier_currency))fail();
   suppliers.set(role,{slug:s.supplier_slug,currency:s.supplier_currency,input:decimal(s.supplier_input),output:decimal(s.supplier_output)});
  }
  if(!suppliers.has('primary'))fail();models.set(model.model_name,{tiers,suppliers,defaultTier:p.processing});
 }
 return Object.freeze({models:Object.freeze([...models.keys()]),quote({model,promptTokens,completionTokens,tier,supplier='primary'}){
  const entry=models.get(model);if(!entry)fail();
  // Time-dependent prices require an explicit trusted tier; no silent off-peak assumption.
  if(tier===undefined){if(entry.defaultTier!=='standard')fail();tier='standard';}
  const retail=entry.tiers.get(tier),upstream=entry.suppliers.get(supplier);if(!retail||!upstream)fail();
  const retailUsd=tokenCost(retail.input,retail.output,promptTokens,completionTokens);
  const native=tokenCost(upstream.input,upstream.output,promptTokens,completionTokens);
  const usd=upstream.currency==='USD'?native:ceil(native*fx,fxScale);
  const cny=upstream.currency==='CNY'?native:ceil(native*fxScale,fx);
  return Object.freeze({model,rateVersion,tier,supplierSlug:upstream.slug,supplierCurrency:upstream.currency,
   retailUsdMicros:safe(retailUsd),estimatedSupplierNativeMicros:safe(native),estimatedSupplierUsdMicros:safe(usd),
   estimatedSupplierCnyMicros:safe(cny),estimatedGrossUsdMicros:safe(retailUsd)-safe(usd),supplierCostVerified:false});
 }});
}
