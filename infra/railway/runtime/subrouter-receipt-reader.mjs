// GET-only reader for the documented account log. No inference/payment request.
import {strictObject,exactInteger,withDeadline} from './supabase-gateway-rpc.mjs';
import {createSupplierConversionGuard,normalizedQuotaCnyMicros,readSubrouterAccountJson,validateNativeDebit} from './subrouter-supplier-conversion.mjs';
import {isSupplierRequestIdentity} from './supplier-request-identity.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A complete bounded scan is required even after a match, to detect duplicates.
const MAX_LOG_PAGES=50;
const fail=(code='supplier_receipt_unverified')=>Object.assign(new Error(code),{code});
export function createSubrouterReceiptReader({enabled=false,accessToken,accountUserId,bindings,conversion,fetchImpl=fetch,clock=Date.now,timeoutMs=20000,requireUsageTokens=false}={}){
 if(enabled!==true)return Object.freeze({readReceipt:async()=>{throw fail();},assertConversion:async()=>{throw fail();}});
 if(typeof accessToken!=='string'||accessToken.length<16||accessToken.length>8192||/[\x00-\x20\x7f]/.test(accessToken))throw fail();
 exactInteger(accountUserId,1,Number.MAX_SAFE_INTEGER);exactInteger(timeoutMs,1,30000);
 if(typeof requireUsageTokens!=='boolean')throw fail();
 if(!bindings||typeof bindings!=='object'||Array.isArray(bindings)||!Object.keys(bindings).length||Object.keys(bindings).length>2)throw fail();
 const trusted=new Map();
 for(const [key,value]of Object.entries(bindings)){
  if(!UUID.test(key))throw fail();strictObject(value,['tokenId','modelProviders']);exactInteger(value.tokenId,1,Number.MAX_SAFE_INTEGER);
  const models=value.modelProviders;if(!models||typeof models!=='object'||Array.isArray(models)||!Object.keys(models).length||Object.keys(models).length>40)throw fail();
  for(const [model,provider]of Object.entries(models))if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(model)||typeof provider!=='string'||!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(provider))throw fail();
  trusted.set(key,{tokenId:value.tokenId,modelProviders:Object.freeze({...models})});
 }
 const guard=createSupplierConversionGuard({conversion,fetchImpl,clock});const c=guard.conversion;
 return Object.freeze({assertConversion:guard.assertConversion,async readReceipt(query,{signal:parent}={}){
  strictObject(query,['keyReference','upstreamResponseId','model']);const binding=trusted.get(query.keyReference);
  if(!binding)throw fail('supplier_binding_not_found');
  if(!Object.hasOwn(binding.modelProviders,query.model))throw fail('supplier_model_mismatch');
  if(!isSupplierRequestIdentity(query.upstreamResponseId,{supplierSlug:binding.modelProviders[query.model],model:query.model}))throw fail('supplier_upstream_identity_mismatch');
  return withDeadline(async deadline=>{
   const signal=parent?AbortSignal.any([parent,deadline]):deadline;
   try{await guard.assertConversion({signal});}catch(error){throw fail(error?.code==='supplier_access_token_rejected'?'supplier_access_token_rejected':'supplier_conversion_guard_failed');}
   let cursor='first',found;const seen=new Set();let complete=false;
   for(let page=0;page<MAX_LOG_PAGES;page++){
    if(typeof cursor!=='string'||!cursor.length||cursor.length>512||/[\x00-\x20\x7f]/.test(cursor)||seen.has(cursor))throw fail('supplier_scan_invalid_cursor');seen.add(cursor);
    let data;try{data=await readSubrouterAccountJson('/api/log/self?cursor='+encodeURIComponent(cursor)+ '&page_size=20',{accessToken,accountUserId,fetchImpl,signal});}catch(error){if(error?.code==='supplier_access_token_rejected')throw error;throw fail('supplier_scan_failed');}
    if(!Array.isArray(data.items)||data.items.length>20||data.page_size!==20||typeof data.has_more!=='boolean'||typeof data.next_cursor!=='string')throw fail('supplier_scan_invalid_page');
    for(const row of data.items){
     if(!row||row.upstream_request_id!==query.upstreamResponseId)continue;
     if(found)throw fail('supplier_receipt_duplicate');
     if(row.user_id!==accountUserId)throw fail('supplier_account_mismatch');
     if(row.token_id!==binding.tokenId)throw fail('supplier_token_mismatch');
     if(row.model_name!==query.model)throw fail('supplier_model_mismatch');
     if(row.type!==2)throw fail('supplier_log_type_mismatch');
     if(typeof row.request_id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(row.request_id)||typeof row.other!=='string'||Buffer.byteLength(row.other)>16384)throw fail('supplier_receipt_invalid');
     let other;try{other=JSON.parse(row.other);}catch{throw fail('supplier_receipt_invalid');}
     if(!other||typeof other!=='object'||Array.isArray(other)||other.provider_slug!==binding.modelProviders[query.model]
      ||other.billing_source!=='wallet'||other.billing_multiplier!==1)throw fail('supplier_receipt_source_mismatch');
     let costCnyMicros,nativeDebit,usage;
     try{
      costCnyMicros=normalizedQuotaCnyMicros(row.quota,c);
      nativeDebit=validateNativeDebit({quota:row.quota,quota_unit_currency:'USD',quota_per_unit:c.quotaPerUnit,price:c.price,usd_exchange_rate:c.usdExchangeRate,
       quota_display_type:c.displayCurrency,display_in_currency:c.displayInCurrency,settings_observed_at:c.observedAt,settings_valid_until:c.validUntil,
       settings_sha256:c.settingsSha256,log_id:row.id,log_created_at:row.created_at,account_user_id:accountUserId,token_id:row.token_id,
       provider_slug:other.provider_slug,billing_source:other.billing_source,billing_multiplier:other.billing_multiplier},costCnyMicros);
      // AARO settlement additionally binds the supplier's own token counts.
      // The default API WILD receipt shape is preserved for its existing oracle.
      usage=requireUsageTokens?Object.freeze({inputTokens:exactInteger(row.prompt_tokens,1,1000000000),outputTokens:exactInteger(row.completion_tokens,0,1000000000)}):undefined;
     }catch{throw fail('supplier_conversion_guard_failed');}
     found=Object.freeze({receiptId:row.request_id,keyReference:query.keyReference,upstreamResponseId:query.upstreamResponseId,model:query.model,currency:'CNY',costCnyMicros,final:true,nativeDebit,...(usage?{usage}:{})});
    }
    if(!data.has_more){complete=true;break;}cursor=data.next_cursor;
   }
   if(!complete)throw fail('supplier_scan_incomplete');
   if(!found)throw fail('supplier_receipt_not_found');
   if(signal.aborted)throw fail('supplier_scan_cancelled');
   try{await guard.assertConversion({signal});}catch(error){throw fail(error?.code==='supplier_access_token_rejected'?'supplier_access_token_rejected':'supplier_conversion_guard_failed');}
   return found;
  },timeoutMs);
 }});
}
