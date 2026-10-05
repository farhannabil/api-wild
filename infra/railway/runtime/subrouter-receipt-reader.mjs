// GET-only reader for the documented account log. No inference/payment request.
import {strictObject,exactInteger,withDeadline} from './supabase-gateway-rpc.mjs';
import {createSupplierConversionGuard,normalizedQuotaCnyMicros,readSubrouterAccountJson,validateNativeDebit} from './subrouter-supplier-conversion.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=()=>Error('supplier_receipt_unverified');
export function createSubrouterReceiptReader({enabled=false,accessToken,accountUserId,bindings,conversion,fetchImpl=fetch,clock=Date.now,timeoutMs=20000}={}){
 if(enabled!==true)return Object.freeze({readReceipt:async()=>{throw fail();},assertConversion:async()=>{throw fail();}});
 if(typeof accessToken!=='string'||accessToken.length<16||accessToken.length>8192||/[\x00-\x20\x7f]/.test(accessToken))throw fail();
 exactInteger(accountUserId,1,Number.MAX_SAFE_INTEGER);exactInteger(timeoutMs,1,30000);
 if(!bindings||typeof bindings!=='object'||Array.isArray(bindings)||!Object.keys(bindings).length||Object.keys(bindings).length>2)throw fail();
 const trusted=new Map();
 for(const [key,value]of Object.entries(bindings)){
  if(!UUID.test(key))throw fail();strictObject(value,['tokenId','modelProviders']);exactInteger(value.tokenId,1,Number.MAX_SAFE_INTEGER);
  const models=value.modelProviders;if(!models||typeof models!=='object'||Array.isArray(models)||!Object.keys(models).length||Object.keys(models).length>39)throw fail();
  for(const [model,provider]of Object.entries(models))if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(model)||typeof provider!=='string'||!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(provider))throw fail();
  trusted.set(key,{tokenId:value.tokenId,modelProviders:Object.freeze({...models})});
 }
 const guard=createSupplierConversionGuard({conversion,fetchImpl,clock});const c=guard.conversion;
 return Object.freeze({assertConversion:guard.assertConversion,async readReceipt(query,{signal:parent}={}){
  strictObject(query,['keyReference','upstreamResponseId','model']);const binding=trusted.get(query.keyReference);
  if(!binding||!UUID.test(query.upstreamResponseId)||!Object.hasOwn(binding.modelProviders,query.model))throw fail();
  return withDeadline(async deadline=>{
   const signal=parent?AbortSignal.any([parent,deadline]):deadline;await guard.assertConversion({signal});
   let cursor='first',found;const seen=new Set();let complete=false;
   for(let page=0;page<10;page++){
    if(typeof cursor!=='string'||!cursor.length||cursor.length>512||/[\x00-\x20\x7f]/.test(cursor)||seen.has(cursor))throw fail();seen.add(cursor);
    const data=await readSubrouterAccountJson('/api/log/self?cursor='+encodeURIComponent(cursor)+ '&page_size=20',{accessToken,accountUserId,fetchImpl,signal});
    if(!Array.isArray(data.items)||data.items.length>20||data.page_size!==20||typeof data.has_more!=='boolean'||typeof data.next_cursor!=='string')throw fail();
    for(const row of data.items){
     if(!row||row.upstream_request_id!==query.upstreamResponseId)continue;
     if(found||row.user_id!==accountUserId||row.token_id!==binding.tokenId||row.model_name!==query.model||row.type!==2
      ||typeof row.request_id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(row.request_id)||typeof row.other!=='string'||Buffer.byteLength(row.other)>16384)throw fail();
     const other=JSON.parse(row.other);if(!other||typeof other!=='object'||Array.isArray(other)||other.provider_slug!==binding.modelProviders[query.model]
      ||other.billing_source!=='wallet'||other.billing_multiplier!==1)throw fail();
     const costCnyMicros=normalizedQuotaCnyMicros(row.quota,c);
     const nativeDebit=validateNativeDebit({quota:row.quota,quota_unit_currency:'USD',quota_per_unit:c.quotaPerUnit,price:c.price,usd_exchange_rate:c.usdExchangeRate,
      quota_display_type:c.displayCurrency,display_in_currency:c.displayInCurrency,settings_observed_at:c.observedAt,settings_valid_until:c.validUntil,
      settings_sha256:c.settingsSha256,log_id:row.id,log_created_at:row.created_at,account_user_id:accountUserId,token_id:row.token_id,
      provider_slug:other.provider_slug,billing_source:other.billing_source,billing_multiplier:other.billing_multiplier},costCnyMicros);
     found=Object.freeze({receiptId:row.request_id,keyReference:query.keyReference,upstreamResponseId:query.upstreamResponseId,model:query.model,currency:'CNY',costCnyMicros,final:true,nativeDebit});
    }
    if(!data.has_more){complete=true;break;}cursor=data.next_cursor;
   }
   if(!complete||!found||signal.aborted)throw fail();await guard.assertConversion({signal});return found;
  },timeoutMs);
 }});
}
