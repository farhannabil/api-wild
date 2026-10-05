// SERVER ONLY, SOURCE PREPARATION. No default ingress, flag activation, secret discovery or supplier call.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { strictObject, exactInteger, withDeadline } from './supabase-gateway-rpc.mjs';

export const AARO_PROTOCOL = 'aaro-subrouter-usage-v1';
export const AARO_BILLING_ORIGIN = 'https://apiwild.com';
export const AARO_SUPABASE_ORIGIN = 'https://yautmilnpllojugpmfgy.supabase.co';
export const AARO_CAP_CNY_MICROS = 50_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const OWNER = /^(live|test):supabase:[0-9a-f-]{36}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const BINDING = ['protocol','product','owner','mode','keyReference','tariffVersion','acceptanceReceiptSHA256','model','requestKey','payloadHash','maximumInputTokens','maximumOutputTokens','totalCapNativeCnyMicros'];
const FACT = ['providerRequestId','inputTokens','outputTokens','actualNativeCnyMicros','supplierDebitReference','reconciliationReceiptSHA256','observedOnly'];
const bridgeInstances = new WeakSet();
const registeredBridge = handler => {bridgeInstances.add(handler);return handler;};
export function isAaroUsageBridge(value){return bridgeInstances.has(value);}
const RPC = { reserve: 'aaro_usage_reserve_v1', read: 'aaro_usage_read_v1', claim: 'aaro_usage_claim_v1', settle: 'aaro_usage_settle_v1', uncertain: 'aaro_usage_uncertain_v1', expire: 'aaro_usage_expire_v1' };
const json = (value, status=200) => Response.json(value,{status,headers:{'Cache-Control':'private, no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'}});
export class AaroUsageError extends Error {
  constructor(code,status=503){super(code);this.name='AaroUsageError';this.code=code;this.status=status;}
}
function exact(value,fields) {
  strictObject(value,fields);
  if(fields.some(key=>!Object.hasOwn(value,key)))throw new AaroUsageError('INVALID_USAGE_REQUEST',400);
  return value;
}
function boundedText(value,pattern){if(typeof value!=='string'||!pattern.test(value))throw new AaroUsageError('INVALID_USAGE_REQUEST',400);return value;}
function integer(value,min,max){try{return exactInteger(value,min,max);}catch{throw new AaroUsageError('INVALID_USAGE_REQUEST',400);}}
export function validateAaroBinding(value){
  exact(value,BINDING);
  if(value.protocol!==AARO_PROTOCOL||value.product!=='aaro'||!['live','test'].includes(value.mode)
    ||!OWNER.test(value.owner)||!UUID.test(value.owner.slice(value.owner.indexOf(':supabase:')+10))
    ||!value.owner.startsWith(value.mode+':supabase:')||value.totalCapNativeCnyMicros!==AARO_CAP_CNY_MICROS)throw new AaroUsageError('INVALID_USAGE_BINDING',400);
  for(const key of ['keyReference','tariffVersion'])boundedText(value[key],REF);
  for(const key of ['acceptanceReceiptSHA256','payloadHash'])boundedText(value[key],SHA);
  boundedText(value.model,MODEL);boundedText(value.requestKey,/^[A-Za-z0-9_-]{16,80}$/);
  integer(value.maximumInputTokens,1,128000);integer(value.maximumOutputTokens,1,4096);
  return JSON.parse(JSON.stringify(value));
}
function fact(value,record){
  exact(value,FACT);
  boundedText(value.providerRequestId,REF);boundedText(value.supplierDebitReference,REF);boundedText(value.reconciliationReceiptSHA256,SHA);
  integer(value.inputTokens,1,1_000_000_000);integer(value.outputTokens,0,1_000_000_000);
  if(typeof value.observedOnly!=='boolean')throw new AaroUsageError('UNVERIFIED_SUPPLIER_RECEIPT');
  integer(value.actualNativeCnyMicros,0,Number.MAX_SAFE_INTEGER);
  return JSON.parse(JSON.stringify(value));
}
function validateRecord(value,owner,id,binding){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
  boundedText(value.id,UUID);if(value.owner!==owner||(id&&value.id!==id))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
  validateAaroBinding(value.binding);
  if(binding&&JSON.stringify(value.binding)!==JSON.stringify(binding)) {
    // JSONB key order differs from JavaScript. Compare immutable fields, never serialized ordering.
    if(BINDING.some(key=>value.binding[key]!==binding[key]))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
  }
  if(value.binding.owner!==owner||value.binding.keyReference!==value.key_reference||value.binding.mode!==value.billing_mode
    ||value.binding.requestKey!==value.request_key||!['reserved','executing','uncertain','succeeded','cancelled'].includes(value.state))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
  integer(value.maximum_credits,1,1_000_000);integer(value.maximum_native_cny_micros,1,AARO_CAP_CNY_MICROS);
  integer(value.actual_credits,0,value.maximum_credits);integer(value.actual_native_cny_micros,0,value.maximum_native_cny_micros);
  integer(value.observed_native_cny_micros,0,Number.MAX_SAFE_INTEGER);
  boundedText(value.admission_receipt_sha256,SHA);
  if(typeof value.expires_at!=='string'||!Number.isFinite(Date.parse(value.expires_at)))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
  if(value.state==='succeeded')fact({providerRequestId:value.provider_request_id,inputTokens:value.input_tokens,outputTokens:value.output_tokens,
    actualNativeCnyMicros:value.actual_native_cny_micros,supplierDebitReference:value.supplier_debit_reference,reconciliationReceiptSHA256:value.reconciliation_receipt_sha256,observedOnly:false},value);
  if(value.state==='succeeded'&&(value.input_tokens>value.binding.maximumInputTokens||value.output_tokens>value.binding.maximumOutputTokens))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
  else if(value.state!=='succeeded'&&(value.actual_credits!==0||value.actual_native_cny_micros!==0))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
  return value;
}
async function readJSON(message,limit,signal){
  if(message instanceof Response&&!/^application\/json(?:;|$)/i.test(message.headers.get('content-type')||''))throw new AaroUsageError('UNVERIFIED_USAGE_RESPONSE');
  const reader=message.body?.getReader();if(!reader)throw new AaroUsageError('INVALID_USAGE_REQUEST',400);
  const chunks=[];let count=0;const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
    for(;;){signal.throwIfAborted();const {done,value}=await reader.read();signal.throwIfAborted();if(done)break;count+=value.byteLength;
      if(count>limit){await reader.cancel();throw new AaroUsageError('USAGE_BODY_TOO_LARGE',message instanceof Request?413:503);}chunks.push(value);}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,count)));}catch{throw new AaroUsageError('INVALID_USAGE_JSON',message instanceof Request?400:503);}
  }finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}
function secret(value,elevated){
  if(typeof value!=='string'||value.length>8192)throw new AaroUsageError('UNCONFIGURED_USAGE_RPC');
  if((elevated?/^sb_secret_[A-Za-z0-9_-]{16,256}$/:/^sb_publishable_[A-Za-z0-9_-]{16,256}$/).test(value))return {value,legacy:false};
  if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))throw new AaroUsageError('UNCONFIGURED_USAGE_RPC');
  let claims;try{claims=JSON.parse(Buffer.from(value.split('.')[1],'base64url'));}catch{throw new AaroUsageError('UNCONFIGURED_USAGE_RPC');}
  if(claims.ref!=='yautmilnpllojugpmfgy'||claims.role!==(elevated?'service_role':'anon'))throw new AaroUsageError('UNCONFIGURED_USAGE_RPC');
  return {value,legacy:true}; // Shape is not a verified key or live acceptance receipt.
}
const SQL_ERRORS = {
  aaro_customer_unaccepted:403,aaro_request_not_found:404,aaro_invalid_binding:400,
  aaro_invalid_settlement:400,aaro_usage_bound_exceeded:409,aaro_budget_unregistered:503,
  aaro_budget_unaccepted:503,aaro_tariff_unaccepted:503,aaro_budget_binding_mismatch:409,
  aaro_request_conflict:409,aaro_settlement_conflict:409,aaro_request_unclaimed:409,
  aaro_claim_unaccepted:409,aaro_quote_exceeded:409,aaro_native_budget_exhausted:402,
  aaro_credits_insufficient:402,aaro_concurrent_limit:409,aaro_isolation_unsupported:503,
};

// Allowlisted server transport only. No DATABASE_URL, raw SQL/table API or credentials in DTOs.
export function createAaroUsageRpc(config){
  exact(config,['secretKey','publishableKey','fetchImpl']);
  const key=secret(config.secretKey,true),publishable=secret(config.publishableKey,false),fetcher=config.fetchImpl;
  if(typeof fetcher!=='function')throw new AaroUsageError('UNCONFIGURED_USAGE_RPC');
  const call=async(operation,parameters,signal)=>{
    if(!Object.hasOwn(RPC,operation))throw new AaroUsageError('INVALID_USAGE_REQUEST',400);
    const headers={apikey:key.value,'Content-Type':'application/json',Accept:'application/json','Content-Profile':'public'};
    if(key.legacy)headers.Authorization='Bearer '+key.value;
    const response=await fetcher(AARO_SUPABASE_ORIGIN+'/rest/v1/rpc/'+RPC[operation],{method:'POST',headers,body:JSON.stringify(parameters),redirect:'error',cache:'no-store',signal});
    const value=await readJSON(response,16_384,signal);
    if(!response.ok){
      if(value?.code==='P0001'&&Object.hasOwn(SQL_ERRORS,value.message))throw new AaroUsageError(value.message,SQL_ERRORS[value.message]);
      if(value?.code==='23505')throw new AaroUsageError('SUPPLIER_RECEIPT_ALREADY_USED',409);
      throw new AaroUsageError('USAGE_LEDGER_UNAVAILABLE');
    }
    if(!value||typeof value!=='object'||Array.isArray(value))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
    if(JSON.stringify(value).includes(key.value))throw new AaroUsageError('UNVERIFIED_USAGE_LEDGER');
    return value;
  };
  return Object.freeze({
    async verifyCustomer(token,signal){
      boundedText(token,/^[A-Za-z0-9_.-]{1,4096}$/);
      const response=await fetcher(AARO_SUPABASE_ORIGIN+'/auth/v1/user',{headers:{apikey:publishable.value,Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',cache:'no-store',signal});
      const user=await readJSON(response,16_384,signal);
      if(!response.ok||!UUID.test(user?.id)||user.is_anonymous!==false||typeof user.email_confirmed_at!=='string'||!Number.isFinite(Date.parse(user.email_confirmed_at)))throw new AaroUsageError('UNVERIFIED_CUSTOMER',403);
      return Object.freeze({id:user.id});
    },
    reserve:(owner,binding,signal)=>call('reserve',{p_owner:owner,p_binding:validateAaroBinding(binding)},signal),
    read:(owner,id,signal)=>call('read',{p_owner:boundedText(owner,OWNER),p_id:boundedText(id,UUID)},signal),
    claim:(owner,id,binding,signal)=>call('claim',{p_owner:owner,p_id:boundedText(id,UUID),p_binding:validateAaroBinding(binding)},signal),
    settle:(owner,id,binding,receipt,signal)=>call('settle',{p_owner:owner,p_id:boundedText(id,UUID),p_binding:validateAaroBinding(binding),p_fact:receipt},signal),
    uncertain:(owner,id,signal)=>call('uncertain',{p_owner:boundedText(owner,OWNER),p_id:boundedText(id,UUID)},signal),
    expire:(owner,id,signal)=>call('expire',{p_owner:boundedText(owner,OWNER),p_id:boundedText(id,UUID)},signal),
  });
}
function signature(key,receipt){return createHmac('sha256',key).update(AARO_PROTOCOL+'\n'+receipt.id+'\n'+receipt.owner+'\n'+receipt.expires).digest('hex');}
function signedReceipt(record,key){
  const expires=Math.floor(Date.parse(record.expires_at)/1000),now=Math.floor(Date.now()/1000);
  if(expires<=now+34||expires>now+600)throw new AaroUsageError('UNVERIFIED_RECEIPT_WINDOW');
  const receipt={id:record.id,owner:record.owner,expires};return {...receipt,signature:signature(key,receipt)};
}
function verifyReceipt(raw,id,key){
  exact(raw,['id','owner','expires','signature']);boundedText(raw.id,UUID);boundedText(raw.owner,OWNER);boundedText(raw.signature,SHA);
  integer(raw.expires,1,Number.MAX_SAFE_INTEGER);
  const now=Math.floor(Date.now()/1000);
  if(raw.id!==id||raw.expires<=now||raw.expires>now+600)throw new AaroUsageError('INVALID_USAGE_RECEIPT',401);
  const expected=signature(key,raw);
  if(!timingSafeEqual(Buffer.from(raw.signature,'hex'),Buffer.from(expected,'hex')))throw new AaroUsageError('INVALID_USAGE_RECEIPT',401);
  return raw.owner;
}
function publicRecord(record){
  return {...record.binding,id:record.id,state:record.state,nativeCurrency:'CNY',maximumCredits:record.maximum_credits,
    maximumNativeCnyMicros:record.maximum_native_cny_micros};
}
function settledRecord(record,replayed=false){
  return {...publicRecord(record),settled:record.state==='succeeded',replayed,
    providerRequestId:record.provider_request_id,inputTokens:record.input_tokens,outputTokens:record.output_tokens,
    actualCredits:record.actual_credits,actualNativeCnyMicros:record.actual_native_cny_micros,
    supplierDebitReference:record.supplier_debit_reference,reconciliationReceiptSHA256:record.reconciliation_receipt_sha256};
}
// The debit oracle is a TRUSTED server callback with independently accepted supplier access.
// It must read/reconcile actual native CNY liability. No request/env boolean is a substitute.
// Missing/unaccepted config returns503; no existing preparation ingress imports this factory.
export function createAaroUsageBridge(config={}){
  if(config.enabled!==true||config.financialAcceptanceVerified!==true||config.providerAcceptanceVerified!==true||config.webhookIngressVerified!==true
    ||!config.rpc||['verifyCustomer','reserve','read','claim','settle','uncertain'].some(name=>typeof config.rpc[name]!=='function')
    ||typeof config.reconcileSupplierDebit!=='function')return registeredBridge(async()=>json({error:'AARO versioned finance is awaiting acceptance.',code:'AARO_FINANCE_UNACCEPTED'},503));
  strictObject(config,['enabled','financialAcceptanceVerified','providerAcceptanceVerified','webhookIngressVerified','billingMode','keyReference','tariffVersion','acceptanceReceiptSHA256','bridgeKey','rpc','reconcileSupplierDebit','deadlineMilliseconds']);
  if(!['live','test'].includes(config.billingMode)||!/^[A-Za-z0-9_-]{32,256}$/.test(config.bridgeKey||''))throw new AaroUsageError('INVALID_USAGE_CONFIGURATION');
  boundedText(config.keyReference,REF);boundedText(config.tariffVersion,REF);boundedText(config.acceptanceReceiptSHA256,SHA);
  const deadline=integer(config.deadlineMilliseconds??12_000,1,15_000);
  const {rpc}=config;
  return registeredBridge(async request=>{
    if(request.method!=='POST')return json({error:'Use POST.'},405);
    const url=new URL(request.url);
    if(url.origin!==AARO_BILLING_ORIGIN||url.pathname!=='/api/aaro/usage'||url.search||request.headers.get('origin')!==AARO_BILLING_ORIGIN)return json({error:'Invalid bridge origin.'},403);
    if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'JSON required.'},415);
    const provided=request.headers.get('x-aaro-bridge')||'';
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(provided)||provided.length!==config.bridgeKey.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(config.bridgeKey)))return json({error:'Unauthorized credit bridge.'},403);
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(deadline)]);
    try{
      const body=await readJSON(request,4096,signal);
      if(!body||typeof body!=='object'||Array.isArray(body))throw new AaroUsageError('INVALID_USAGE_REQUEST',400);
      if(body.action==='reserve'){
        exact(body,['action',...BINDING]);const {action,...binding}=body;validateAaroBinding(binding);
        if(binding.mode!==config.billingMode||binding.keyReference!==config.keyReference||binding.tariffVersion!==config.tariffVersion||binding.acceptanceReceiptSHA256!==config.acceptanceReceiptSHA256)throw new AaroUsageError('UNACCEPTED_USAGE_POLICY',409);
        const authorization=request.headers.get('authorization')||'';
        if(!/^Bearer [A-Za-z0-9_.-]{1,4096}$/.test(authorization))throw new AaroUsageError('UNVERIFIED_CUSTOMER',401);
        const user=await rpc.verifyCustomer(authorization.slice(7),signal);signal.throwIfAborted();
        if(!UUID.test(user?.id))throw new AaroUsageError('UNVERIFIED_CUSTOMER',403);
        const owner=config.billingMode+':supabase:'+user.id;if(binding.owner!==owner)throw new AaroUsageError('OWNER_MISMATCH',403);
        const value=await rpc.reserve(owner,binding,signal),record=validateRecord(value.record,owner,undefined,binding);
        if(value.fresh!==true||record.state!=='reserved')throw new AaroUsageError('REQUEST_ALREADY_RECEIVED',409);
        return json({...publicRecord(record),reserved:true,fresh:true,claimed:false,totalCapNativeCnyMicros:AARO_CAP_CNY_MICROS,
          providerAdmissionReceiptSHA256:record.admission_receipt_sha256,receipt:signedReceipt(record,config.bridgeKey)});
      }
      if(!['claim','settle','uncertain'].includes(body.action))throw new AaroUsageError('INVALID_USAGE_ACTION',400);
      exact(body,body.action==='uncertain'?['action','protocol','product','id','receipt']:['action',...BINDING.filter(k=>k!=='totalCapNativeCnyMicros'),'id','receipt',...(body.action==='settle'?['providerRequestId','inputTokens','outputTokens']:[])]);
      if(body.protocol!==AARO_PROTOCOL||body.product!=='aaro')throw new AaroUsageError('INVALID_USAGE_BINDING',400);
      const owner=verifyReceipt(body.receipt,body.id,config.bridgeKey);
      const record=validateRecord((await rpc.read(owner,body.id,signal)).record,owner,body.id);
      if(Math.floor(Date.parse(record.expires_at)/1000)!==body.receipt.expires)throw new AaroUsageError('INVALID_USAGE_RECEIPT',401);
      if(body.action==='uncertain'){
        signal.throwIfAborted();const value=await rpc.uncertain(owner,body.id,signal);validateRecord(value.record,owner,body.id,record.binding);
        return json({held:value.held===true,state:value.record.state});
      }
      const {action,id,receipt,providerRequestId,inputTokens,outputTokens,...submitted}=body;
      const binding={...submitted,totalCapNativeCnyMicros:AARO_CAP_CNY_MICROS};validateAaroBinding(binding);
      if(BINDING.some(key=>record.binding[key]!==binding[key]))throw new AaroUsageError('USAGE_BINDING_CHANGED',409);
      if(body.action==='claim'){
        if(binding.mode!==config.billingMode||binding.keyReference!==config.keyReference||binding.tariffVersion!==config.tariffVersion||binding.acceptanceReceiptSHA256!==config.acceptanceReceiptSHA256)throw new AaroUsageError('UNACCEPTED_USAGE_POLICY',409);
        signal.throwIfAborted();const value=await rpc.claim(owner,id,binding,signal),claimed=validateRecord(value.record,owner,id,binding);
        if(value.claimed!==true||claimed.state!=='executing')throw new AaroUsageError('REQUEST_ALREADY_CLAIMED',409);
        return json({...publicRecord(claimed),claimed:true,totalCapNativeCnyMicros:AARO_CAP_CNY_MICROS});
      }
      boundedText(providerRequestId,REF);integer(inputTokens,1,binding.maximumInputTokens);integer(outputTokens,0,binding.maximumOutputTokens);
      if(record.state==='succeeded'){
        if(record.provider_request_id!==providerRequestId||record.input_tokens!==inputTokens||record.output_tokens!==outputTokens)throw new AaroUsageError('SETTLEMENT_CHANGED',409);
        return json(settledRecord(record,true));
      }
      if(!['executing','uncertain'].includes(record.state))throw new AaroUsageError('REQUEST_UNCLAIMED',409);
      // The browser/AARO caller never supplies actual supplier debit, price or receipt proof.
      const proof=await withDeadline(async localSignal=>config.reconcileSupplierDebit({record:Object.freeze(structuredClone(record)),providerRequestId,inputTokens,outputTokens,
        signal:AbortSignal.any([signal,localSignal])}),Math.min(5000,deadline));
      exact(proof,['product','owner','reservationId','mode','keyReference','model','providerRequestId','inputTokens','outputTokens','actualNativeCnyMicros','supplierDebitReference','reconciliationReceiptSHA256']);
      if(proof.product!=='aaro'||proof.owner!==owner||proof.reservationId!==id||proof.mode!==binding.mode||proof.keyReference!==binding.keyReference||proof.model!==binding.model
        ||proof.providerRequestId!==providerRequestId)throw new AaroUsageError('SUPPLIER_DEBIT_UNRECONCILED');
      const verified=fact({...Object.fromEntries(FACT.filter(key=>key!=='observedOnly').map(key=>[key,proof[key]])),observedOnly:proof.inputTokens!==inputTokens||proof.outputTokens!==outputTokens},record);
      signal.throwIfAborted();
      const value=await rpc.settle(owner,id,binding,verified,signal),settled=validateRecord(value.record,owner,id,binding);
      if(value.settled!==true||settled.state!=='succeeded')return json({...publicRecord(settled),settled:false,code:'NATIVE_LIABILITY_REQUIRES_RECONCILIATION'});
      return json(settledRecord(settled,value.replayed===true));
    }catch(error){
      return json({error:'AARO credit work could not be verified. Do not repeat paid work automatically.',
        code:error instanceof AaroUsageError?error.code:signal.aborted?'USAGE_REQUEST_INTERRUPTED':'AARO_USAGE_UNVERIFIED'},signal.aborted?504:error instanceof AaroUsageError?error.status:503);
    }
  });
}
