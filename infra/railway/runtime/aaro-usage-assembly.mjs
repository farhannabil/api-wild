// Explicit AARO runtime assembly; existing API WILD defaults are preserved.
import {createAaroUsageBridge,createAaroUsageRpc} from './aaro-usage-bridge.mjs';
import {createAaroUsageIngress} from './aaro-usage-ingress.mjs';
import {createAaroSupplierOracle} from './aaro-supplier-oracle.mjs';
import {strictObject} from './supabase-gateway-rpc.mjs';
const flags=['AARO_FINANCE_ENABLED','AARO_FINANCIAL_ACCEPTANCE_VERIFIED','AARO_PROVIDER_ACCEPTANCE_VERIFIED','AARO_WEBHOOK_INGRESS_VERIFIED'];
const parse=(raw,max)=>{if(typeof raw!=='string'||Buffer.byteLength(raw)>max)throw Error('aaro_configuration_unaccepted');return JSON.parse(raw);};
export function createAaroUsageFromEnv({env={},fetchImpl=fetch,clock=Date.now}={}){
 if(env.AARO_FINANCE_ENABLED!=='true')return undefined;
 const closed=()=>createAaroUsageIngress({bridge:createAaroUsageBridge()});
 if(!flags.every(key=>env[key]==='true'))return closed();
 try{
  const manifest=parse(env.AARO_SUBROUTER_MANIFEST,16384),binding=parse(env.AARO_SUPPLIER_BINDING_JSON,16384);
  strictObject(manifest,['protocol','product','mode','keyReference','tariffVersion','acceptanceReceiptSHA256','totalCapNativeCnyMicros','maxCallNativeCnyMicros','models']);
  strictObject(binding,['product','mode','keyReference','tokenId','accountUserId','modelProviders']);
  if(manifest.protocol!=='aaro-subrouter-usage-v1'||manifest.product!=='aaro'||manifest.totalCapNativeCnyMicros!==50000000
   ||binding.product!=='aaro'||binding.mode!==manifest.mode||binding.keyReference!==manifest.keyReference
   ||!Number.isSafeInteger(manifest.maxCallNativeCnyMicros)||manifest.maxCallNativeCnyMicros<1||manifest.maxCallNativeCnyMicros>50000000)throw Error();
  const families=Object.keys(manifest.models??{}),models=Object.values(manifest.models??{}).map(route=>route.model);
  if(models.length<1||models.length>6||new Set(models).size!==models.length
   ||families.some(family=>!['gpt','claude','gemini','kimi','qwen','deepseek'].includes(family))
   ||models.length!==Object.keys(binding.modelProviders??{}).length||models.some(model=>!Object.hasOwn(binding.modelProviders,model)))throw Error();
  for(const route of Object.values(manifest.models)){
   strictObject(route,['model','maxInputTokens','maxOutputTokens']);
   if(!Number.isSafeInteger(route.maxInputTokens)||route.maxInputTokens<1||route.maxInputTokens>128000
    ||!Number.isSafeInteger(route.maxOutputTokens)||route.maxOutputTokens<1||route.maxOutputTokens>4096)throw Error();
  }
  // Reject known API WILD identities. Rotating keys cannot add another allowance.
  const enterprise=parse(env.APIWILD_SUPPLIER_BINDINGS_JSON??'{}',16384);
  if(Object.hasOwn(enterprise,binding.keyReference)||Object.values(enterprise).some(key=>key.tokenId===binding.tokenId))throw Error();
  const oracle=createAaroSupplierOracle({enabled:true,product:'aaro',mode:manifest.mode,keyReference:manifest.keyReference,
   tokenId:binding.tokenId,accountUserId:binding.accountUserId,modelProviders:binding.modelProviders,tariffVersion:manifest.tariffVersion,
   acceptanceReceiptSHA256:manifest.acceptanceReceiptSHA256,totalCapNativeCnyMicros:50000000,
   accessToken:env.AARO_SUBROUTER_ACCOUNT_ACCESS_TOKEN,conversion:parse(env.AARO_SUPPLIER_CONVERSION_JSON,8192),fetchImpl,clock});
  const rpc=createAaroUsageRpc({secretKey:env.SUPABASE_SECRET_KEY,publishableKey:env.SUPABASE_PUBLISHABLE_KEY,fetchImpl});
  const bridge=createAaroUsageBridge({enabled:true,financialAcceptanceVerified:true,providerAcceptanceVerified:true,webhookIngressVerified:true,
   billingMode:manifest.mode,keyReference:manifest.keyReference,tariffVersion:manifest.tariffVersion,
   acceptanceReceiptSHA256:manifest.acceptanceReceiptSHA256,bridgeKey:env.AARO_BRIDGE_KEY,rpc,reconcileSupplierDebit:oracle.reconcileSupplierDebit});
  return createAaroUsageIngress({bridge});
 }catch{return closed();} // Never log private config or break API WILD on AARO failure.
}
