// Adapter contract, NOT a fabricated Subrouter accounting endpoint. readReceipt
// must independently fetch authoritative accounting. USD-native quota requires
// an immutable pinned conversion audit; token estimates are never receipts.
import {createHash} from 'node:crypto';
import {validateNativeDebit} from './subrouter-supplier-conversion.mjs';
import {cloneJsonObject, strictObject, exactInteger, withDeadline} from './supabase-gateway-rpc.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x20\x7f]/.test(value);
const fail=code=>Object.assign(new Error(code),{code});
const REASONS=new Map([['supplier_invalid_reference','invalid_reference'],['supplier_request_unverified','request_unverified'],['supplier_binding_not_found','binding_not_found'],['supplier_model_mismatch','model_mismatch'],['supplier_upstream_identity_mismatch','upstream_identity_mismatch'],['supplier_token_mismatch','token_mismatch'],['supplier_account_mismatch','account_mismatch'],['supplier_log_type_mismatch','log_type_mismatch'],['supplier_receipt_source_mismatch','receipt_source_mismatch'],['supplier_receipt_invalid','receipt_invalid'],['supplier_receipt_duplicate','duplicate_receipt'],['supplier_receipt_not_found','receipt_not_found'],['supplier_scan_incomplete','incomplete_scan'],['supplier_scan_invalid_cursor','invalid_scan_cursor'],['supplier_scan_invalid_page','invalid_scan_page'],['supplier_scan_failed','scan_failed'],['supplier_scan_cancelled','scan_cancelled'],['supplier_access_token_rejected','access_token_rejected'],['supplier_conversion_guard_failed','conversion_guard_failed'],['supplier_receipt_unverified','receipt_unverified'],['supplier_request_read_failed','request_read_failed'],['supplier_reconciliation_rpc_failed','reconciliation_rpc_failed'],['supplier_reconciliation_rpc_rejected','reconciliation_rejected'],['gateway_deadline_exceeded','reconciliation_timeout']]);
const reason=error=>REASONS.get(error?.code)||'reconciliation_unclassified';
export function createSupplierDebitReconciler({enabled=false,readRequest,readReceipt,rpc,timeoutMs=15000}={}) {
  if(enabled!==true)return Object.freeze({reconcile:async()=>{throw fail('supplier_reconciliation_disabled');}});
  if([readRequest,readReceipt,rpc].some(fn=>typeof fn!=='function'))throw fail('supplier_reconciliation_unconfigured');
  exactInteger(timeoutMs,1,30000);
  return Object.freeze({async reconcile(raw){
    strictObject(raw,['owner','requestId']);
    const {owner,requestId}=raw;
    if(typeof owner!=='string'||!/^(live|test):supabase:[0-9a-f-]{36}$/.test(owner)||!UUID.test(owner.split(':')[2])||!UUID.test(requestId))throw fail('supplier_invalid_reference');
    try{return await withDeadline(async signal=>{
      let request;try{request=cloneJsonObject(await readRequest({owner,requestId},{signal}),4096);}catch(error){throw fail(error?.code||'supplier_request_read_failed');}
      if(request.owner!==owner||request.requestId!==requestId||request.supplierPending!==true
          ||!UUID.test(request.keyReference)||!text(request.model)||!text(request.upstreamResponseId))throw fail('supplier_request_unverified');
      let receipt;try{receipt=cloneJsonObject(await readReceipt({keyReference:request.keyReference,
        upstreamResponseId:request.upstreamResponseId,model:request.model},{signal}),4096);}catch(error){throw fail(error?.code||'supplier_receipt_unverified');}
      strictObject(receipt,['receiptId','keyReference','upstreamResponseId','model','currency','costCnyMicros','final','nativeDebit']);
      if(!text(receipt.receiptId)||receipt.keyReference!==request.keyReference||receipt.upstreamResponseId!==request.upstreamResponseId
          ||receipt.model!==request.model||receipt.currency!=='CNY'||receipt.final!==true)throw fail('supplier_receipt_unverified');
      exactInteger(receipt.costCnyMicros,0,1000000000000);
      // Fixed field order provides stable idempotency across object insertion orders.
      const fact={receipt_id:receipt.receiptId,key_reference:receipt.keyReference,upstream_response_id:receipt.upstreamResponseId,
        model:receipt.model,currency:'CNY',cost_cny_micros:receipt.costCnyMicros,
        ...(Object.hasOwn(receipt,'nativeDebit')?{native_debit:validateNativeDebit(receipt.nativeDebit,receipt.costCnyMicros)}:{})};
      const digest=createHash('sha256').update(JSON.stringify(fact)).digest('hex');
      if(signal.aborted)throw Error();
      const result=await rpc('apiwild_supplier_debit_apply',{p_owner:owner,p_request:requestId,p_fact:fact,p_digest:digest},{signal});
      if(result?.reconciled!==true)return Object.freeze({reconciled:false,held:true,reason:'reconciliation_rejected',automaticRetry:false});
      return Object.freeze({reconciled:true,held:false,automaticRetry:false});
    },timeoutMs);}catch(error){return Object.freeze({reconciled:false,held:true,reason:reason(error),automaticRetry:false});}
  }});
}
