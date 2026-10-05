import {createGatewayRpc,SUPABASE_ORIGIN,GatewayError,exactInteger} from './supabase-gateway-rpc.mjs';
import {createCustomerKeyRpc} from './customer-key-rpc.mjs';
import {createGatewayService} from './gateway-service.mjs';
import {createGatewayIngress} from './gateway-ingress.mjs';
import {createGatewayHttp} from './gateway-http.mjs';
import {createSubrouterDispatch} from './subrouter-dispatch.mjs';
import {createRetailTokenPricing} from './retail-token-pricing.mjs';
import {createModelAccounting} from './model-accounting.mjs';
import {chatInputBytes,usesFunctionTools} from './chat-compatibility.mjs';
import {createDeepSeekTierPolicy} from './deepseek-tier-policy.mjs';
import {createOwnedDiscoverySnapshot} from './owned-discovery-http.mjs';
import {createSupplierConversionGuard} from './subrouter-supplier-conversion.mjs';
import {createResearchTools} from './research-tools.mjs';
export function createOwnedGatewayFromEnv({env,catalog,fetchImpl=fetch,clock=Date.now}){
 if(env.APIWILD_OWNED_GATEWAY_ENABLED!=='true')return undefined;
 const secretKey=env.SUPABASE_SECRET_KEY,publishableKey=env.SUPABASE_PUBLISHABLE_KEY,billingMode=env.APIWILD_BILLING_MODE;
 if(!['live','test'].includes(billingMode)||!secretKey||!publishableKey)throw Error('Owned gateway credentials are incomplete.');
 const inferenceEnabled=env.APIWILD_INFERENCE_ENABLED==='true';
 let entries=[];if(inferenceEnabled){if(!env.SUBROUTER_API_KEY)throw Error('Subrouter upstream key is missing.');try{entries=JSON.parse(env.APIWILD_GATEWAY_ROUTES_JSON);}catch{throw Error('Owned gateway routes are missing.');}if(!Array.isArray(entries)||!entries.length)throw Error('Owned gateway routes are empty.');}
 const rateVersion=env.APIWILD_RETAIL_RATE_VERSION||'inactive';
 const conditional=model=>['deepseek-v4-flash','deepseek-v4-pro'].includes(model);
 let tierPolicy,conditionalSupplierRates={};
 if(inferenceEnabled&&env.APIWILD_DEEPSEEK_TARIFF_ENABLED==='true'){
  try{tierPolicy=createDeepSeekTierPolicy({enabled:true,config:JSON.parse(env.APIWILD_DEEPSEEK_TARIFF_POLICY_JSON),clock});conditionalSupplierRates=JSON.parse(env.APIWILD_DEEPSEEK_SUPPLIER_RATES_JSON);}catch{throw new GatewayError('deepseek_tariff_unverified');}
 }
 const pricing=createRetailTokenPricing({models:catalog.models,rateVersion,tierPolicy});
 const accounting=inferenceEnabled?createModelAccounting({catalog,rateVersion,tierPolicy,conditionalSupplierRates}):null;
 const routes=entries.flatMap(e=>{
  if(!pricing.models.includes(e.model))throw Error('Route has no approved retail tariff.');
  exactInteger(e.maxInputTokens,1,1000000);exactInteger(e.supplierReserveCnyMicros,1,50000000);
  const offer=catalog.models.find(m=>m.model_name===e.model)?.[e.supplierRole||'primary'];
  if(!offer||!e.supplierSlug||offer.supplier_slug!==e.supplierSlug)throw Error('Route supplier must match the selected catalog offer.');
  if(conditional(e.model)&&!accounting.conditionalReady(e.model,e.supplierRole||'primary'))throw new GatewayError('deepseek_supplier_tariff_unverified');
  const versions=conditional(e.model)?tierPolicy.versions(e.model):[rateVersion];
  return versions.map(version=>({...e,rateVersion:version,apiKey:env.SUBROUTER_API_KEY}));
 });
 const base={supabaseOrigin:SUPABASE_ORIGIN,secretKey,publishableKey,billingMode,fetchImpl};
 const auth=createGatewayRpc(base),keys=createCustomerKeyRpc({supabaseOrigin:SUPABASE_ORIGIN,secretKey,billingMode,verifyOwner:async raw=>{const context=await auth.verifyOwner(raw);await auth.initializeAccount(context);return context;},fetchImpl});
 const rpc=createGatewayRpc({...base,keyVerifier:keys,retailSettlement:true});
 const upstreamDispatch=createSubrouterDispatch({fetchImpl,routes:routes.map(({maxInputTokens,supplierReserveCnyMicros,supplierRole,...r})=>r)});
 let conversionGuard;if(inferenceEnabled){try{conversionGuard=createSupplierConversionGuard({conversion:JSON.parse(env.APIWILD_SUPPLIER_CONVERSION_JSON),fetchImpl,clock});}catch{throw new GatewayError('supplier_conversion_unverified');}}
 const dispatch=async work=>{if(conditional(work.record.model))tierPolicy.assertDispatch(work.record.model,work.record.rate_version);await conversionGuard.assertConversion({signal:work.signal});return upstreamDispatch(work);};
 const service=createGatewayService({rpc,dispatch,verifySettlement:async({record,providerResult})=>{
  const route=routes.find(r=>r.model===record.model&&r.providerBudgetId===record.provider_budget_id&&r.capability===record.capability&&r.rateVersion===record.rate_version);
  if(!route||providerResult.model!==route.upstreamModel||!providerResult.providerResponseId)throw new GatewayError('retail_response_unverified');
  // Supplier-added input is bounded independently of the doubled money quote.
  // An overrun stays uncertain; no customer finish or automatic redispatch.
  exactInteger(providerResult.usage?.prompt_tokens,0,route.maxInputTokens);
  const tokenQuote={model:record.model,promptTokens:providerResult.usage.prompt_tokens,completionTokens:providerResult.usage.completion_tokens,supplier:route.supplierRole||'primary'};
  const economics=conditional(record.model)?accounting.quoteRecorded({...tokenQuote,requestRateVersion:record.rate_version}):accounting.quote(tokenQuote);
  if(economics.estimatedSupplierCnyMicros>record.reserved_cny_micros)throw new GatewayError('supplier_quote_bound_exceeded');
  const charge=pricing.charge({model:record.model,promptTokens:providerResult.usage.prompt_tokens,completionTokens:providerResult.usage.completion_tokens,requestRateVersion:record.rate_version});
  // Prefer the response's wallet-log correlation ID. Existing SQL binds the
  // receipt to this immutable reference; completion ID remains private evidence.
  const supplierCorrelationId=providerResult.providerRequestId??providerResult.providerResponseId;
  return {state:'succeeded',costUsdMicros:charge.costUsdMicros,costCnyMicros:0,settlementReference:'usage:'+supplierCorrelationId,result:{text:providerResult.text,model:record.model,created:providerResult.created,finishReason:providerResult.finishReason,usage:providerResult.usage,...(providerResult.toolCalls?{toolCalls:providerResult.toolCalls}:{})},usage:{...providerResult.usage,supplierReconciliationPending:true,estimatedSupplierCnyMicros:economics.estimatedSupplierCnyMicros,providerCompletionId:providerResult.providerResponseId,supplierSlug:route.supplierSlug,...(providerResult.providerRequestId?{providerRequestId:providerResult.providerRequestId}:{})}};
 }});
 const playgroundModels=[...new Map(routes.map(r=>[r.model+'|'+r.capability,{model:r.model,capability:r.capability,maxOutputTokens:r.maxOutputTokens,supportsTools:r.supportsTools===true}])).values()];
 const discovery=createOwnedDiscoverySnapshot({catalog,routes:playgroundModels,rateVersion,tierPolicy,deploymentCommit:env.RAILWAY_GIT_COMMIT_SHA,workspaceToolsEnabled:true});
 const ingress=createGatewayIngress({rpc,keys,service,discovery,researchTools:createResearchTools(),origin:'https://apiwild.com',enabled:true,playgroundModels,selectQuote:async({context,model,capability,maxTokens,payload,requestKey,payloadHash})=>{
  if(!inferenceEnabled)throw new GatewayError('gateway_inference_disabled');
  if(conditional(model)){
   const prior=await rpc.lookupQuote(context,{keyId:context.keyId??null,requestKey,payloadHash,capability,model});
   if(prior)return prior; // Recovery uses the immutable quote; never reprice or redispatch.
  }
  const route=routes.find(r=>r.model===model&&r.capability===capability);if(!route||maxTokens>route.maxOutputTokens)throw new GatewayError('gateway_route_unavailable');
  if(usesFunctionTools(payload.body)&&route.supportsTools!==true)throw new GatewayError('gateway_route_unavailable');
  const bytes=chatInputBytes({...payload.body,model:route.upstreamModel});if(bytes>route.maxInputChars||bytes>route.maxInputTokens)throw new GatewayError('gateway_input_bound',413);
  const selection=conditional(model)?tierPolicy.select(model):undefined;
  const quote={model,promptTokens:route.maxInputTokens,completionTokens:maxTokens,supplier:route.supplierRole||'primary'};
  const economics=selection?accounting.quoteConditional({...quote,selection}):accounting.quote(quote);
  if(economics.estimatedSupplierCnyMicros>route.supplierReserveCnyMicros)throw new GatewayError('supplier_reserve_below_quote');
  const requestRateVersion=selection?.rateVersion??rateVersion;
  return {providerBudgetId:route.providerBudgetId,model,rateVersion:requestRateVersion,reservedUsdMicros:Math.max(1,pricing.charge({model,promptTokens:route.maxInputTokens,completionTokens:maxTokens,requestRateVersion}).costUsdMicros),reservedCnyMicros:route.supplierReserveCnyMicros};
 }});
 return createGatewayHttp({ingress,discovery});
}
