import {SUPABASE_ORIGIN,strictObject,withDeadline} from './supabase-gateway-rpc.mjs';
import {createSupplierDebitRpc} from './supplier-debit-operator.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=()=>Error('supplier_scan_unavailable');
export function createSupplierPendingList({secretKey,billingMode,keyReferences,fetchImpl=fetch}){
 createSupplierDebitRpc({secretKey,fetchImpl}); // Reuse the exact fixed-project credential validation, no request.
 if(!['live','test'].includes(billingMode)||!Array.isArray(keyReferences)||!keyReferences.length||keyReferences.length>2||keyReferences.some(k=>!UUID.test(k)))throw fail();
 const keys=[...keyReferences];
 return async(cursor,{signal:parent}={})=>withDeadline(async deadline=>{
  const signal=parent?AbortSignal.any([parent,deadline]):deadline;
  if(cursor!==null){strictObject(cursor,['createdAt','requestId']);if(!UUID.test(cursor.requestId)||typeof cursor.createdAt!=='string'||!Number.isFinite(Date.parse(cursor.createdAt)))throw fail();}
  let response,reader;const cancel=()=>{try{void(reader?.cancel()??response?.body?.cancel())?.catch(()=>{});}catch{}};
  signal.addEventListener('abort',cancel,{once:true});
  try{
   if(signal.aborted)throw fail();const url=SUPABASE_ORIGIN+'/rest/v1/rpc/apiwild_supplier_pending_list';
   response=await fetchImpl(url,{method:'POST',redirect:'error',cache:'no-store',signal,headers:{apikey:secretKey,...(secretKey.startsWith('sb_secret_')?{}:{authorization:'Bearer '+secretKey}),'content-type':'application/json',accept:'application/json','content-profile':'public'},
    body:JSON.stringify({p_billing_mode:billingMode,p_key_references:keys,p_after_created_at:cursor?.createdAt??null,p_after_id:cursor?.requestId??null})});
   if(signal.aborted||!(response instanceof Response)||!response.ok||response.redirected||(response.url&&response.url!==url)||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw fail();
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))throw fail();
   reader=response.body?.getReader();if(!reader)throw fail();let size=0;const chunks=[];
   for(;;){const {done,value}=await reader.read();if(signal.aborted)throw fail();if(done)break;if(!(value instanceof Uint8Array)||(size+=value.length)>8192||chunks.length>=1024)throw fail();chunks.push(value);}
   const rows=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
   if(!Array.isArray(rows)||rows.length>5)throw fail();let prior=cursor;
   return rows.map(row=>{strictObject(row,['owner','requestId','createdAt']);
    if(typeof row.owner!=='string'||!row.owner.startsWith(billingMode+':supabase:')||!UUID.test(row.owner.slice(billingMode.length+10))
     ||!UUID.test(row.requestId)||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))throw fail();
    // Preserve the database timestamp precision in the scan cursor.
    if(prior&&(Date.parse(row.createdAt)<Date.parse(prior.createdAt)||(row.createdAt===prior.createdAt&&row.requestId<=prior.requestId)))throw fail();
    prior=row;return Object.freeze({...row});});
  }finally{signal.removeEventListener('abort',cancel);cancel();try{reader?.releaseLock();}catch{}}
 },8000);
}
