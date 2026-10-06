// Server-only AARO debit oracle. It reads account logs; it never dispatches,
// funds, rotates keys, or turns source fixtures into acceptance evidence.
import {createHash} from 'node:crypto';
import {createSubrouterReceiptReader} from './subrouter-receipt-reader.mjs';
import {validateAaroBinding,AARO_CAP_CNY_MICROS} from './aaro-usage-bridge.mjs';
import {strictObject,exactInteger} from './supabase-gateway-rpc.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA=/^[a-f0-9]{64}$/;
const fail=()=>{throw Error('aaro_supplier_receipt_unverified');};
export function createAaroSupplierOracle(config={}){
 if(config.enabled!==true)return Object.freeze({reconcileSupplierDebit:async()=>fail()});
 strictObject(config,['enabled','product','mode','keyReference','tokenId','modelProviders','tariffVersion','acceptanceReceiptSHA256','totalCapNativeCnyMicros','accessToken','accountUserId','conversion','fetchImpl','clock','timeoutMs']);
 if(config.product!=='aaro'||!['live','test'].includes(config.mode)||!UUID.test(config.keyReference)
  ||!REF.test(config.tariffVersion)||!SHA.test(config.acceptanceReceiptSHA256)||config.totalCapNativeCnyMicros!==AARO_CAP_CNY_MICROS)fail();
 if(!config.modelProviders||typeof config.modelProviders!=='object'||Array.isArray(config.modelProviders)
  ||Object.keys(config.modelProviders).length<1||Object.keys(config.modelProviders).length>6)fail();
 const keyReference=config.keyReference,mode=config.mode,tariffVersion=config.tariffVersion,acceptance=config.acceptanceReceiptSHA256;
 const modelProviders=Object.freeze({...config.modelProviders});
 const reader=createSubrouterReceiptReader({enabled:true,accessToken:config.accessToken,accountUserId:config.accountUserId,
  bindings:{[keyReference]:{tokenId:config.tokenId,modelProviders}},conversion:config.conversion,requireUsageTokens:true,
  fetchImpl:config.fetchImpl??fetch,clock:config.clock??Date.now,timeoutMs:config.timeoutMs??5000});
 return Object.freeze({async reconcileSupplierDebit(raw){
  strictObject(raw,['record','providerRequestId','inputTokens','outputTokens','signal']);
  const {record,providerRequestId,signal}=raw;
  if(!record||!UUID.test(record.id)||!['executing','uncertain'].includes(record.state)||!REF.test(providerRequestId))fail();
  const binding=validateAaroBinding(record.binding);
  if(record.owner!==binding.owner||record.billing_mode!==mode||record.key_reference!==keyReference
   ||binding.mode!==mode||binding.keyReference!==keyReference||binding.tariffVersion!==tariffVersion
   ||binding.acceptanceReceiptSHA256!==acceptance||!Object.hasOwn(modelProviders,binding.model))fail();
  exactInteger(raw.inputTokens,1,binding.maximumInputTokens);exactInteger(raw.outputTokens,0,binding.maximumOutputTokens);
  if(signal?.aborted)fail();
  const receipt=await reader.readReceipt({keyReference,upstreamResponseId:providerRequestId,model:binding.model},{signal});
  if(!REF.test(receipt.receiptId)||receipt.keyReference!==keyReference||receipt.upstreamResponseId!==providerRequestId
   ||receipt.model!==binding.model||receipt.currency!=='CNY'||receipt.final!==true||signal?.aborted)fail();
  // Counts and debit are from the independently matched wallet log. A mismatch
  // with completion JSON is preserved by the bridge as an observed, held liability.
  const proof={product:'aaro',owner:record.owner,reservationId:record.id,mode,keyReference,model:binding.model,
   providerRequestId,inputTokens:receipt.usage.inputTokens,outputTokens:receipt.usage.outputTokens,
   actualNativeCnyMicros:receipt.costCnyMicros,supplierDebitReference:receipt.receiptId};
  const reconciliationReceiptSHA256=createHash('sha256').update(JSON.stringify({...proof,nativeDebit:receipt.nativeDebit})).digest('hex');
  return Object.freeze({...proof,reconciliationReceiptSHA256});
 }});
}
