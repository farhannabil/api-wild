import {randomUUID} from 'node:crypto';
import {nativeReceipt,nativeAllowance} from './native-customer-keys.mjs';
import {nativeTokenDetails} from './usage-analytics.mjs';
export function createNativeUsageSync({manager,clock=Date.now,write=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){
 if(!manager)return {start(){},async stop(){},async runPass(){return {disabled:true};}};
 let stopped=false,timer,pending;
 async function syncKey(key){
  const run=randomUUID();if(!await manager.rpc('apiwild_native_sync_claim',{p_key:key.key_id,p_run:run}))return {busy:true};
  try{
   let token=key.token_id?await manager.native.read(key.token_id):await manager.native.find(key.token_name);
   manager.verifyToken(token,key);
   if(!key.token_id){if(token.used_quota!==0||token.remain_quota!==0)throw Error('unbound_token_used');await manager.rpc('apiwild_native_key_attach',{p_owner:key.owner,p_id:key.key_id,p_token:token.id});key={...key,token_id:token.id};}
   const baselineUsed=token.used_quota;
   await manager.assertConversion?.();
   const end=Math.floor(clock()/1000),start=Math.floor(Date.parse(key.created_at)/1000)-5;let cursor='first',complete=false,imported=0;
   for(let page=0;page<100;page++){
    const data=await manager.native.call('/api/log/self?type=2&start_timestamp='+start+'&end_timestamp='+end+'&cursor='+encodeURIComponent(cursor)+'&page_size=100');
    if(!Array.isArray(data.items)||data.items.length>100||typeof data.has_more!=='boolean')throw Error('native_log_invalid');
    const rows=data.items.filter(r=>r.token_id===key.token_id),facts=rows.map(r=>nativeReceipt(r,key));
    if(facts.length){const result=await manager.rpc('apiwild_native_import',{p_key:key.key_id,p_run:run,p_rows:facts});imported+=result.imported;
     try{await manager.rpc('apiwild_native_usage_details',{p_key:key.key_id,p_run:run,p_rows:rows.map((row,i)=>nativeTokenDetails(row,facts[i]))});}catch{write({analyticsUnavailable:true});}
    }
    if(!data.has_more){complete=true;break;}if(typeof data.next_cursor!=='string'||!data.next_cursor||data.next_cursor===cursor)throw Error('native_log_cursor_invalid');cursor=data.next_cursor;
   }
   if(!complete)throw Error('native_log_scan_incomplete');
   let after=await manager.native.read(key.token_id);manager.verifyToken(after,key);
   if(![1,2].includes(after.status)||after.used_quota<baselineUsed)throw Error('native_usage_in_flight');
   await manager.rpc('apiwild_native_sync_finish',{p_key:key.key_id,p_run:run,p_used:after.used_quota});
   if(key.revoked_at||Date.parse(key.expires_at)<=clock()||manager.expiry<=clock()){if(after.status!==2)await manager.native.setStatus(after,2);return {imported,enabled:false};}
   const usage=await manager.rpc('apiwild_gateway_usage',{p_owner:key.owner});const policy=await manager.billingPolicy?.();const allocation=nativeAllowance(usage.availableUsdMicros,key.rates,policy?.active===true);
   if(allocation.quota<1){if(after.status!==2)await manager.native.setStatus(after,2);await manager.native.update(after,{remain_quota:0});return {imported,enabled:false};}
   // The allocator clamps the reserve to the real remaining headroom (wallet,
   // account/key limits, supplier budget) and returns what it reserved; the
   // token quota must never exceed the backed amount. A failed or malformed
   // allocation leaves the token without a backing lease, so fail closed until
   // the next pass re-funds it.
   let lease;
   try{lease=await manager.rpc('apiwild_native_allocate',{p_key:key.key_id,p_run:run,p_usd:allocation.reserveUsdMicros,p_cny:allocation.reserveCnyMicros});}catch{lease=null;}
   const backed=lease&&Number.isSafeInteger(lease.reservedUsdMicros)&&lease.reservedUsdMicros>=1?Math.min(allocation.quota,Math.floor(lease.reservedUsdMicros/10)):0;
   if(backed<1){if(after.status!==2)await manager.native.setStatus(after,2);await manager.native.update(after,{remain_quota:0});return {imported,enabled:false,allowanceUnavailable:true};}
   const expiry=Math.floor(Math.min(clock()+65*60000,Date.parse(key.expires_at),manager.expiry)/1000);
   await manager.rpc('apiwild_native_sync_assert',{p_key:key.key_id,p_run:run});
   for(let attempt=0;attempt<3;attempt++){
    const current=attempt===0?after:await manager.native.read(key.token_id);manager.verifyToken(current,key);
    if(![1,2].includes(current.status)||current.used_quota<baselineUsed)throw Error('native_allowance_unconfirmed');
    const target=Math.max(0,backed-(current.used_quota-baselineUsed));
    const prepared=await manager.native.update(current,{remain_quota:Math.min(target,backed),expired_time:expiry});manager.verifyToken(prepared,key);
    if(![1,2].includes(prepared.status)||prepared.expired_time!==expiry||prepared.remain_quota>backed)throw Error('native_allowance_unconfirmed');
    const active=prepared.status===1?prepared:await manager.native.setStatus(prepared,1);manager.verifyToken(active,key);
    const readback=await manager.native.read(key.token_id);manager.verifyToken(readback,key);
    if(readback.status!==1||readback.expired_time!==expiry||readback.used_quota<current.used_quota||readback.remain_quota>backed)throw Error('native_allowance_unconfirmed');
    if(readback.used_quota!==current.used_quota){after=readback;continue;}
    if(readback.remain_quota!==Math.max(0,backed-(readback.used_quota-baselineUsed)))throw Error('native_allowance_unconfirmed');
    return {imported,enabled:true};
   }
   throw Error('native_allowance_unconfirmed');
  }finally{await manager.rpc('apiwild_native_sync_release',{p_key:key.key_id,p_run:run}).catch(()=>{});}
 }
 function runPass(){if(stopped)return Promise.resolve({stopped:true});if(pending)return pending;pending=(async()=>{
  const stats={attempted:0,imported:0,paused:0};try{const keys=await manager.rpc('apiwild_native_key_rows',{p_owner:null});if(!Array.isArray(keys)||keys.length>1000)throw Error();
   for(const key of keys){if(stopped)break;const due=!key.last_synced_at||clock()-Date.parse(key.last_synced_at)>=300000||!key.lease_id;
    if(!due)continue;stats.attempted++;try{const result=await syncKey(key);stats.imported+=result.imported||0;if(result.enabled===false)stats.paused++;if(result.allowanceUnavailable)stats.unfunded=(stats.unfunded||0)+1;}catch{stats.paused++;}
   }
  }catch{stats.unavailable=true;}if(stats.attempted||stats.unavailable)write(stats);return stats;
 })().finally(()=>{pending=null;});return pending;}
 function schedule(){if(stopped)return;timer=setTimer(async()=>{await runPass();schedule();},60000);timer?.unref?.();}
 return {runPass,start(){void runPass();schedule();},async stop(){stopped=true;clearTimer(timer);await pending;}};
}
