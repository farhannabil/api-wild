import {createGatewayRpc,SUPABASE_ORIGIN,GatewayError,exactInteger} from './supabase-gateway-rpc.mjs';
import {createCustomerKeyRpc} from './customer-key-rpc.mjs';
import {createGatewayService} from './gateway-service.mjs';
import {createGatewayIngress} from './gateway-ingress.mjs';
import {createGatewayHttp} from './gateway-http.mjs';
import {createSubrouterDispatch} from './subrouter-dispatch.mjs';
import {createRetailTokenPricing} from './retail-token-pricing.mjs';
export function createOwnedGatewayFromEnv({env,catalog,fetchImpl=fetch}){
 if(env.APIWILD_OWNED_GATEWAY_ENABLED!=='true')return undefined;
 const secretKey=env.SUPABASE_SECRET_KEY,publishableKey=env.SUPABASE_PUBLISHABLE_KEY,billingMode=env.APIWILD_BILLING_MODE;
 if(!['live','test'].includes(billingMode)||!secretKey||!publishableKey)throw Error('Owned gateway credentials are incomplete.');
 const inferenceEnabled=env.APIWILD_INFERENCE_ENABLED==='true';
 let entries=[];if(inferenceEnabled){if(!env.SUBROUTER_API_KEY)throw Error('Subrouter upstream key is missing.');try{entries=JSON.parse(env.APIWILD_GATEWAY_ROUTES_JSON);}catch{throw Error('Owned gateway routes are missing.');}if(!Array.isArray(entries)||!entries.length)throw Error('Owned gateway routes are empty.');}
 const rateVersion=env.APIWILD_RETAIL_RATE_VERSION||'inactive',pricing=createRetailTokenPricing({models:catalog.models,rateVersion});
 const routes=entries.map(e=>{if(!pricing.models.includes(e.model))throw Error('Route has no approved retail tariff.');exactInteger(e.maxInputTokens,1,1000000);exactInteger(e.supplierReserveCnyMicros,1,50000000);return {...e,rateVersion,apiKey:env.SUBROUTER_API_KEY};});
 const base={supabaseOrigin:SUPABASE_ORIGIN,secretKey,publishableKey,billingMode,fetchImpl};
 const auth=createGatewayRpc(base),keys=createCustomerKeyRpc({supabaseOrigin:SUPABASE_ORIGIN,secretKey,billingMode,verifyOwner:async raw=>{const context=await auth.verifyOwner(raw);await auth.initializeAccount(context);return context;},fetchImpl});
 const rpc=createGatewayRpc({...base,keyVerifier:keys,retailSettlement:true});
 const dispatch=createSubrouterDispatch({fetchImpl,routes:routes.map(({maxInputTokens,supplierReserveCnyMicros,...r})=>r)});
 const service=createGatewayService({rpc,dispatch,verifySettlement:async({record,providerResult})=>{
  const route=routes.find(r=>r.model===record.model&&r.providerBudgetId===record.provider_budget_id&&r.capability===record.capability);
  if(!route||providerResult.model!==route.upstreamModel||!providerResult.providerResponseId)throw new GatewayError('retail_response_unverified');
  const charge=pricing.charge({model:record.model,promptTokens:providerResult.usage.prompt_tokens,completionTokens:providerResult.usage.completion_tokens});
  return {state:'succeeded',costUsdMicros:charge.costUsdMicros,costCnyMicros:0,settlementReference:'usage:'+providerResult.providerResponseId,result:{text:providerResult.text,model:record.model,finishReason:providerResult.finishReason,usage:providerResult.usage},usage:{...providerResult.usage,supplierReconciliationPending:true}};
 }});
 const ingress=createGatewayIngress({rpc,keys,service,origin:'https://apiwild.com',enabled:true,playgroundModels:routes.map(r=>({model:r.model,capability:r.capability,maxOutputTokens:r.maxOutputTokens})),selectQuote:async({model,capability,maxTokens,payload})=>{
  if(!inferenceEnabled)throw new GatewayError('gateway_inference_disabled');
  const route=routes.find(r=>r.model===model&&r.capability===capability);if(!route||maxTokens>route.maxOutputTokens)throw new GatewayError('gateway_route_unavailable');
  const bytes=Buffer.byteLength(JSON.stringify(payload.body.messages));if(bytes>route.maxInputChars||bytes>route.maxInputTokens)throw new GatewayError('gateway_input_bound',413);
  return {providerBudgetId:route.providerBudgetId,model,rateVersion,reservedUsdMicros:Math.max(1,pricing.charge({model,promptTokens:route.maxInputTokens,completionTokens:maxTokens}).costUsdMicros),reservedCnyMicros:route.supplierReserveCnyMicros};
 }});
 return createGatewayHttp({ingress});
}
