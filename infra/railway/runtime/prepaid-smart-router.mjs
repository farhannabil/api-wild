import {GatewayError, strictObject} from './supabase-gateway-rpc.mjs';
import {usesFunctionTools} from './chat-compatibility.mjs';

export const SMART_MODEL='apiwild/auto';
export const SMART_POLICY_VERSION='usd-v1';
const TEXT_MODEL='gemini-3.1-flash-lite', TOOL_MODEL='MiniMax-M2.7-highspeed';
const choice=body=>usesFunctionTools(body)?TOOL_MODEL:TEXT_MODEL;
const available=(models,id,tools=false)=>models.some(m=>m.id===id&&m.callable===true&&m.capabilities.includes('chat')&&(!tools||m.toolCapabilities.includes('chat')));

// Version-one destinations are fixed, including across process restarts.
// Never reassign this alias or add availability-based fallback: that would
// change a repeated request's immutable quote/fingerprint. A later policy
// needs a distinct alias or a separately reviewed durable decision ledger.
export function resolvePrepaidSmartRoute(input,{enabled=false,models=[],native=false}={}){
 if(input.body.model!==SMART_MODEL)return {input};
 if(native)throw new GatewayError('gateway_request_rejected',400);
 const model=choice(input.body),tools=usesFunctionTools(input.body);
 if(!enabled||!available(models,model,tools))throw new GatewayError('gateway_route_unavailable');
 return {input:{...input,body:{...input.body,model}},routing:{alias:SMART_MODEL,policyVersion:SMART_POLICY_VERSION}};
}

export function assertPrepaidRoutingEnvelope(routing,body){
 strictObject(routing,['alias','policyVersion']);
 if(routing.alias!==SMART_MODEL||routing.policyVersion!==SMART_POLICY_VERSION||body.model!==choice(body))throw new GatewayError('subrouter_request_model_mismatch');
}

export function prepaidSmartRoutingMetadata({enabled=false,models=[]}={}){
 if(!enabled)return {enabled:false};
 return {enabled:true,model:SMART_MODEL,policyVersion:SMART_POLICY_VERSION,quota:'prepaid-usd',
  text:{model:TEXT_MODEL,available:available(models,TEXT_MODEL)},
  functionCalls:{model:TOOL_MODEL,available:available(models,TOOL_MODEL,true)},
  pricing:'selected-model-retail',automaticFallback:false,automaticRetry:false};
}
