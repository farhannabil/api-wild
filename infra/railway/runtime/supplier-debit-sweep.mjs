// Single-flight finite passes. No provider dispatch and no financial hold release
// without the separately verified, idempotent actual-receipt reconciler.
import {createSupplierPendingList} from './supplier-pending-list.mjs';
import {createSupplierDebitRpc} from './supplier-debit-operator.mjs';
import {createSubrouterReceiptReader} from './subrouter-receipt-reader.mjs';
import {createSupplierDebitReconciler} from './supplier-debit-reconciliation.mjs';
import {exactInteger} from './supabase-gateway-rpc.mjs';
export function createSupplierDebitSweep({listPending,reconcile,intervalMs=60000,setTimer=setTimeout,clearTimer=clearTimeout,write=()=>{},controller=new AbortController()}){
 if(typeof listPending!=='function'||typeof reconcile!=='function')throw Error('supplier_sweep_unconfigured');exactInteger(intervalMs,60000,3600000);
 let cursor=null,pending=null,timer=null,started=false,stopped=false;
 function runPass(){
  if(stopped)return Promise.resolve({stopped:true});if(pending)return pending;
  pending=(async()=>{
   let attempted=0,reconciled=0,held=0;
   try{
    const rows=await listPending(cursor,{signal:controller.signal});if(!Array.isArray(rows)||rows.length>5)throw Error();
    for(const row of rows){if(controller.signal.aborted)break;
     attempted++;try{const result=await reconcile({owner:row.owner,requestId:row.requestId});if(result?.reconciled===true)reconciled++;else held++;}catch{held++;}
     cursor={createdAt:row.createdAt,requestId:row.requestId}; // Advance past held receipts so the next page can progress.
    }
    if(rows.length<5&&!controller.signal.aborted)cursor=null;
    const result={attempted,reconciled,held,automaticRetry:false};write(result);return result;
   }catch{const result={attempted,reconciled,held,scanUnavailable:true,automaticRetry:false};write(result);return result;}
  })().finally(()=>{pending=null;});return pending;
 }
 function schedule(delay){timer=setTimer(async()=>{timer=null;await runPass();if(started&&!stopped)schedule(intervalMs);},delay);timer?.unref?.();}
 return Object.freeze({enabled:true,runPass,start(){if(started||stopped)return;started=true;schedule(0);},async stop(){stopped=true;started=false;if(timer!==null)clearTimer(timer);timer=null;controller.abort();await pending;}});
}
export function createSupplierDebitSweepFromEnv({env={},fetchImpl=fetch,clock=Date.now,write=()=>{},setTimer,clearTimer}={}){
 if(env.APIWILD_SUPPLIER_SWEEP_ENABLED!=='true')return Object.freeze({enabled:false,start(){},async stop(){},async runPass(){return {disabled:true};}});
 if(env.APIWILD_SUPPLIER_DEBIT_ENABLED!=='true'||!['live','test'].includes(env.APIWILD_BILLING_MODE)||!/^[1-9][0-9]{0,15}$/.test(env.SUBROUTER_ACCOUNT_USER_ID))throw Error('supplier_sweep_unconfigured');
 const bindings=JSON.parse(env.APIWILD_SUPPLIER_BINDINGS_JSON),conversion=JSON.parse(env.APIWILD_SUPPLIER_CONVERSION_JSON),controller=new AbortController();
 const boundedFetch=(url,init={})=>{if(controller.signal.aborted)throw Error('supplier_sweep_stopped');return fetchImpl(url,{...init,signal:init.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal});};
 const rpc=createSupplierDebitRpc({secretKey:env.SUPABASE_SECRET_KEY,fetchImpl:boundedFetch});
 const reader=createSubrouterReceiptReader({enabled:true,accessToken:env.SUBROUTER_ACCOUNT_ACCESS_TOKEN,accountUserId:Number(env.SUBROUTER_ACCOUNT_USER_ID),bindings,conversion,fetchImpl:boundedFetch,clock});
 const reconciler=createSupplierDebitReconciler({enabled:true,timeoutMs:30000,rpc,readReceipt:reader.readReceipt,
  readRequest:({owner,requestId},options)=>rpc('apiwild_supplier_request_read',{p_owner:owner,p_request:requestId},options)});
 const listPending=createSupplierPendingList({secretKey:env.SUPABASE_SECRET_KEY,billingMode:env.APIWILD_BILLING_MODE,keyReferences:Object.keys(bindings),fetchImpl:boundedFetch});
 return createSupplierDebitSweep({listPending,reconcile:reconciler.reconcile,controller,write,setTimer,clearTimer});
}
