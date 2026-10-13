import {randomUUID} from 'node:crypto';
import {nativeReceipt,nativeAllowance} from './native-customer-keys.mjs';
export function createNativeUsageSync({manager,clock=Date.now,write=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){
 if(!manager)return {start(){},async stop(){},async runPass(){return {disabled:true};}};
 let stopped=false,timer,pending;
 async function syncKey(key){
  const run=randomUUID();if(!await manager.rpc('apiwild_native_sync_claim',{p_key:key.key_id,p_run:run}))return {busy:true};
  try{
   let token=key.token_id?await manager.native.read(key.token_id):await manager.native.find(key.token_name);
   manager.verifyToken(token,key);
   if(!key.token_id){if(token.used_quota!==0||token.remain_quota!==0)throw Error('unbound_token_used');await manager.rpc('apiwild_native_key_attach',{p_owner:key.owner,p_id:key.key_id,p_token:token.id});key={...key,token_id:token.id};}
   // Stop new admission before reconciling. An unknown stop outcome never grants
   // a new allowance. Existing holds remain until complete native quota evidence.
   token=await manager.native.setStatus(token,2);
   token=await manager.native.update(token,{remain_quota:0});
   if(token.status!==2||token.remain_quota!==0||token.unlimited_quota!==false)throw Error('native_stop_unconfirmed');
   await manager.assertConversion?.();
   const end=Math.floor(clock()/1000),start=Math.floor(Date.parse(key.created_at)/1000)-5;let cursor='first',complete=false,imported=0;
   for(let page=0;page<100;page++){
    const data=await manager.native.call('/api/log/self?type=2&start_timestamp='+start+'&end_timestamp='+end+'&cursor='+encodeURIComponent(cursor)+'&page_size=100');
    if(!Array.isArray(data.items)||data.items.length>100||typeof data.has_more!=='boolean')throw Error('native_log_invalid');
    const facts=data.items.filter(r=>r.token_id===key.token_id).map(r=>nativeReceipt(r,key));
    if(facts.length){const result=await manager.rpc('apiwild_native_import',{p_key:key.key_id,p_run:run,p_rows:facts});imported+=result.imported;}
    if(!data.has_more){complete=true;break;}if(typeof data.next_cursor!=='string'||!data.next_cursor||data.next_cursor===cursor)throw Error('native_log_cursor_invalid');cursor=data.next_cursor;
   }
   if(!complete)throw Error('native_log_scan_incomplete');
   const after=await manager.native.read(key.token_id);manager.verifyToken(after,key);
   if(after.status!==2||after.remain_quota!==0||after.used_quota!==token.used_quota)throw Error('native_usage_in_flight');
   await manager.rpc('apiwild_native_sync_finish',{p_key:key.key_id,p_run:run,p_used:after.used_quota});
   if(key.revoked_at||Date.parse(key.expires_at)<=clock()||manager.expiry<=clock())return {imported,enabled:false};
   const usage=await manager.rpc('apiwild_gateway_usage',{p_owner:key.owner});const policy=await manager.billingPolicy?.();const allocation=nativeAllowance(usage.availableUsdMicros,key.rates,policy?.active===true);
   if(allocation.quota<1)return {imported,enabled:false};
   try{await manager.rpc('apiwild_native_allocate',{p_key:key.key_id,p_run:run,p_usd:allocation.reserveUsdMicros,p_cny:allocation.reserveCnyMicros});}catch{return {imported,enabled:false,allowanceUnavailable:true};}
   const expiry=Math.floor(Math.min(clock()+65*60000,Date.parse(key.expires_at),manager.expiry)/1000);
   const prepared=await manager.native.update(after,{remain_quota:allocation.quota,expired_time:expiry});manager.verifyToken(prepared,key);
   if(prepared.status!==2||prepared.remain_quota!==allocation.quota||prepared.expired_time!==expiry)throw Error('native_allowance_unconfirmed');
   await manager.rpc('apiwild_native_sync_assert',{p_key:key.key_id,p_run:run});
   const active=await manager.native.setStatus(prepared,1);manager.verifyToken(active,key);
   // Usage can begin immediately after activation. Never overwrite the native
   // remaining quota to make a readback match the requested allowance.
   if(active.status!==1||active.remain_quota>allocation.quota||active.expired_time!==expiry||active.used_quota<after.used_quota)throw Error('native_allowance_unconfirmed');
   return {imported,enabled:true};
  }finally{await manager.rpc('apiwild_native_sync_release',{p_key:key.key_id,p_run:run}).catch(()=>{});}
 }
 function runPass(){if(stopped)return Promise.resolve({stopped:true});if(pending)return pending;pending=(async()=>{
  const stats={attempted:0,imported:0,paused:0};try{const keys=await manager.rpc('apiwild_native_key_rows',{p_owner:null});if(!Array.isArray(keys)||keys.length>1000)throw Error();
   for(const key of keys){if(stopped)break;const due=!key.last_synced_at||clock()-Date.parse(key.last_synced_at)>=3600000||!key.lease_id;
    if(!due)continue;stats.attempted++;try{const result=await syncKey(key);stats.imported+=result.imported||0;if(result.enabled===false)stats.paused++;}catch{stats.paused++;}
   }
  }catch{stats.unavailable=true;}if(stats.attempted||stats.unavailable)write(stats);return stats;
 })().finally(()=>{pending=null;});return pending;}
 function schedule(){if(stopped)return;timer=setTimer(async()=>{await runPass();schedule();},60000);timer?.unref?.();}
 return {runPass,start(){void runPass();schedule();},async stop(){stopped=true;clearTimer(timer);await pending;}};
}
