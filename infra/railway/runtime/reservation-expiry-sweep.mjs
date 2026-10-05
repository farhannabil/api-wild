// Finite safe-expiry passes. The SQL CAS owns cancellation authority; no inference,
// supplier receipt ingestion, executing-request release or customer credit mutation.
import {SUPABASE_ORIGIN,strictObject,exactInteger,withDeadline} from './supabase-gateway-rpc.mjs';
import {createSupplierDebitRpc} from './supplier-debit-operator.mjs';
import {runReservationExpiryOperator} from './reservation-expiry-operator.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=()=>Error('reservation_expiry_scan_unavailable');
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
function cursorValue(cursor){strictObject(cursor,['expiresAt','requestId']);if(!timestamp(cursor.expiresAt)||!UUID.test(cursor.requestId))throw fail();}
export function createReservationExpiryList({secretKey,billingMode,keyReferences,fetchImpl=fetch}){
 createSupplierDebitRpc({secretKey,fetchImpl}); // Validate fixed-project server credential shape without network.
 if(!['live','test'].includes(billingMode)||!Array.isArray(keyReferences)||!keyReferences.length||keyReferences.length>2
  ||keyReferences.some(k=>!UUID.test(k))||new Set(keyReferences).size!==keyReferences.length)throw fail();
 const keys=[...keyReferences];
 return async(cursor,{signal:parent}={})=>withDeadline(async deadline=>{
  const signal=parent?AbortSignal.any([parent,deadline]):deadline;
  if(cursor!==null)cursorValue(cursor);
  let response,reader;const cancel=()=>{try{void(reader?.cancel()??response?.body?.cancel())?.catch(()=>{});}catch{}};
  signal.addEventListener('abort',cancel,{once:true});
  try{
   if(signal.aborted)throw fail();const url=SUPABASE_ORIGIN+'/rest/v1/rpc/apiwild_reservation_expiry_list';
   response=await fetchImpl(url,{method:'POST',redirect:'error',cache:'no-store',signal,
    headers:{apikey:secretKey,...(secretKey.startsWith('sb_secret_')?{}:{authorization:'Bearer '+secretKey}),'content-type':'application/json',accept:'application/json','content-profile':'public'},
    body:JSON.stringify({p_billing_mode:billingMode,p_key_references:keys,p_after_expires_at:cursor?.expiresAt??null,p_after_id:cursor?.requestId??null})});
   if(signal.aborted||!(response instanceof Response)||!response.ok||response.redirected||(response.url&&response.url!==url)
    ||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw fail();
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))throw fail();
   reader=response.body?.getReader();if(!reader)throw fail();let size=0;const chunks=[];
   for(;;){const {done,value}=await reader.read();if(signal.aborted)throw fail();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.length)>8192||chunks.length>=1024)throw fail();chunks.push(value);}
   const rows=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
   if(!Array.isArray(rows)||rows.length>5)throw fail();let prior=cursor;const ids=new Set();
   return rows.map(row=>{
    strictObject(row,['owner','requestId','expiresAt','version']);cursorValue({expiresAt:row.expiresAt,requestId:row.requestId});
    if(typeof row.owner!=='string'||!row.owner.startsWith(billingMode+':supabase:')||!UUID.test(row.owner.slice(billingMode.length+10))||ids.has(row.requestId))throw fail();
    exactInteger(row.version,0,Number.MAX_SAFE_INTEGER-1);
    if(prior&&(Date.parse(row.expiresAt)<Date.parse(prior.expiresAt)||(row.expiresAt===prior.expiresAt&&row.requestId<=prior.requestId)))throw fail();
    ids.add(row.requestId);prior=row;return Object.freeze({...row});
   });
  }finally{signal.removeEventListener('abort',cancel);cancel();try{reader?.releaseLock();}catch{}}
 },8000);
}
export function createReservationExpirySweep({listExpired,expire,intervalMs=60000,setTimer=setTimeout,clearTimer=clearTimeout,write=()=>{},controller=new AbortController()}){
 if(typeof listExpired!=='function'||typeof expire!=='function')throw fail();exactInteger(intervalMs,60000,3600000);
 let cursor=null,pending=null,timer=null,started=false,stopped=false;
 function runPass(){
  if(stopped)return Promise.resolve({stopped:true});if(pending)return pending;
  pending=(async()=>{
   let attempted=0,cancelled=0,unchanged=0;
   try{
    const rows=await listExpired(cursor,{signal:controller.signal});if(!Array.isArray(rows)||rows.length>5)throw fail();
    for(const row of rows){if(controller.signal.aborted)break;
     attempted++;try{const result=await expire(row,{signal:controller.signal});if(result?.cancelled===true)cancelled++;else unchanged++;}catch{unchanged++;}
     cursor={expiresAt:row.expiresAt,requestId:row.requestId}; // Race/failure cannot starve later candidates.
    }
    if(rows.length<5&&!controller.signal.aborted)cursor=null;
    const result={attempted,cancelled,unchanged,automaticRetry:false};write(result);return result;
   }catch{const result={attempted,cancelled,unchanged,scanUnavailable:true,automaticRetry:false};write(result);return result;}
  })().finally(()=>{pending=null;});return pending;
 }
 function schedule(delay){timer=setTimer(async()=>{timer=null;await runPass();if(started&&!stopped)schedule(intervalMs);},delay);timer?.unref?.();}
 return Object.freeze({enabled:true,runPass,start(){if(started||stopped)return;started=true;schedule(0);},async stop(){stopped=true;started=false;if(timer!==null)clearTimer(timer);timer=null;controller.abort();await pending;}});
}
export function createReservationExpirySweepFromEnv({env={},fetchImpl=fetch,write=()=>{},setTimer,clearTimer}={}){
 if(env.APIWILD_RESERVATION_EXPIRY_ENABLED!=='true')return Object.freeze({enabled:false,start(){},async stop(){},async runPass(){return {disabled:true};}});
 const bindings=JSON.parse(env.APIWILD_SUPPLIER_BINDINGS_JSON);if(!bindings||typeof bindings!=='object'||Array.isArray(bindings))throw fail();
 const controller=new AbortController();
 const boundedFetch=(url,init={})=>{if(controller.signal.aborted)throw fail();return fetchImpl(url,{...init,signal:init.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal});};
 const listExpired=createReservationExpiryList({secretKey:env.SUPABASE_SECRET_KEY,billingMode:env.APIWILD_BILLING_MODE,keyReferences:Object.keys(bindings),fetchImpl:boundedFetch});
 const expire=async row=>{
  let result;const code=await runReservationExpiryOperator({argv:['--execute','--owner',row.owner,'--request',row.requestId,'--version',String(row.version)],env,fetchImpl:boundedFetch,write:value=>{result=value;}});
  return {cancelled:code===0&&result?.cancelled===true};
 };
 return createReservationExpirySweep({listExpired,expire,controller,write,setTimer,clearTimer});
}
