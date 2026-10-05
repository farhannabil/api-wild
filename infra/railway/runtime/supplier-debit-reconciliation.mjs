// Adapter contract, NOT a fabricated Subrouter accounting endpoint. readReceipt
// must independently fetch authoritative native-CNY accounting, not return a
// model response, token estimate, quota units or caller-supplied verified=true.
import {createHash} from 'node:crypto';
import {cloneJsonObject, strictObject, exactInteger, withDeadline} from './supabase-gateway-rpc.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x20\x7f]/.test(value);
const fail=code=>Object.assign(new Error(code),{code});
export function createSupplierDebitReconciler({enabled=false,readRequest,readReceipt,rpc,timeoutMs=15000}={}) {
  if(enabled!==true)return Object.freeze({reconcile:async()=>{throw fail('supplier_reconciliation_disabled');}});
  if([readRequest,readReceipt,rpc].some(fn=>typeof fn!=='function'))throw fail('supplier_reconciliation_unconfigured');
  exactInteger(timeoutMs,1,30000);
  return Object.freeze({async reconcile(raw){
    strictObject(raw,['owner','requestId']);
    const {owner,requestId}=raw;
    if(typeof owner!=='string'||!/^(live|test):supabase:[0-9a-f-]{36}$/.test(owner)||!UUID.test(owner.split(':')[2])||!UUID.test(requestId))throw fail('supplier_invalid_reference');
    try{return await withDeadline(async signal=>{
      const request=cloneJsonObject(await readRequest({owner,requestId},{signal}),4096);
      if(request.owner!==owner||request.requestId!==requestId||request.supplierPending!==true
          ||!UUID.test(request.keyReference)||!text(request.model)||!text(request.upstreamResponseId))throw fail('supplier_request_unverified');
      const receipt=cloneJsonObject(await readReceipt({keyReference:request.keyReference,
        upstreamResponseId:request.upstreamResponseId},{signal}),4096);
      strictObject(receipt,['receiptId','keyReference','upstreamResponseId','model','currency','costCnyMicros','final']);
      if(!text(receipt.receiptId)||receipt.keyReference!==request.keyReference||receipt.upstreamResponseId!==request.upstreamResponseId
          ||receipt.model!==request.model||receipt.currency!=='CNY'||receipt.final!==true)throw fail('supplier_receipt_unverified');
      exactInteger(receipt.costCnyMicros,0,1000000000000);
      // Fixed field order provides stable idempotency across object insertion orders.
      const fact={receipt_id:receipt.receiptId,key_reference:receipt.keyReference,upstream_response_id:receipt.upstreamResponseId,
        model:receipt.model,currency:'CNY',cost_cny_micros:receipt.costCnyMicros};
      const digest=createHash('sha256').update(JSON.stringify(fact)).digest('hex');
      if(signal.aborted)throw Error();
      const result=await rpc('apiwild_supplier_debit_apply',{p_owner:owner,p_request:requestId,p_fact:fact,p_digest:digest},{signal});
      if(result?.reconciled!==true)return Object.freeze({reconciled:false,held:true,automaticRetry:false});
      return Object.freeze({reconciled:true,held:false,automaticRetry:false});
    },timeoutMs);}catch{return Object.freeze({reconciled:false,held:true,automaticRetry:false});}
  }});
}
