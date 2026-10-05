// Server-side approved USD token prices. Supplier liability is accounted separately.
import {GatewayError,exactInteger} from './supabase-gateway-rpc.mjs';
const fail=()=>{throw new GatewayError('retail_price_unverified');};
function rate(value){
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>10000)fail();
 const text=value.toFixed(6);if(Math.abs(Number(text)-value)>1e-10)fail();
 return BigInt(text.replace('.',''));
}
function cost(input,output,prompt,completion){
 exactInteger(prompt,0,10000000);exactInteger(completion,0,10000000);
 const result=(input*BigInt(prompt)+output*BigInt(completion)+999999n)/1000000n;
 if(result>1000000000000n)fail();return Number(result);
}
export function createRetailTokenPricing({models,rateVersion}){
 if(!Array.isArray(models)||typeof rateVersion!=='string'||!rateVersion||rateVersion.length>160)fail();
 const rates=new Map();for(const entry of models){
  const p=entry.apiwild_selling_price;
  if(!p||p.approved!==true||p.currency!=='USD'||p.unit!=='per_million_tokens')continue;
  if(typeof entry.model_name!=='string'||rates.has(entry.model_name))fail();
  // Standard uncached input/output only. No guessed peak/cache/batch tariff.
  if(p.processing!=='standard'||p.input_cache!=='uncached')continue;
  rates.set(entry.model_name,{input:rate(p.input),output:rate(p.output)});
 }
 return Object.freeze({rateVersion,models:Object.freeze([...rates.keys()]),charge({model,promptTokens,completionTokens}){
  const p=rates.get(model);if(!p)fail();return Object.freeze({rateVersion,costUsdMicros:cost(p.input,p.output,promptTokens,completionTokens)});
 }});
}
