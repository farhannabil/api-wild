import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {GatewayError,SUPABASE_ORIGIN,exactInteger} from './supabase-gateway-rpc.mjs';
import {createSupplierConversionGuard} from './subrouter-supplier-conversion.mjs';
const ORIGIN='https://subrouter.ai';
const unavailable=()=>new GatewayError('native_key_unavailable',503,true);
export async function boundedNativeJson(response,max=2000000){
 if(!response.ok||response.redirected||!/^application\/json/.test(response.headers.get('content-type')||''))throw unavailable();
 const reader=response.body?.getReader();if(!reader)throw unavailable();let size=0;const chunks=[];
 try{for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>max)throw unavailable();chunks.push(n.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}
}
export function createNativeTokenClient({accessToken,accountId,fetchImpl=fetch}){
 exactInteger(accountId,1);if(typeof accessToken!=='string'||accessToken.length<16)throw unavailable();
 async function call(path,method='GET',body){try{const j=await boundedNativeJson(await fetchImpl(ORIGIN+path,{method,headers:{Authorization:'Bearer '+accessToken,'New-Api-User':String(accountId),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)}));if(j.success!==true)throw unavailable();return j.data;}catch{throw unavailable();}}
 return Object.freeze({call,async read(id){exactInteger(id,1);const t=await call('/api/token/'+id);if(t.id!==id)throw unavailable();return t;},async find(name){const found=[];for(let page=1;page<=10;page++){const d=await call('/api/token/?p='+page+'&size=100');if(!Array.isArray(d.items)||!Number.isSafeInteger(d.total))throw unavailable();found.push(...d.items.filter(t=>t.name===name));if(page*100>=d.total){if(found.length!==1)throw unavailable();return found[0];}}throw unavailable();},async update(t,changes){
 // Whitelist mutable token fields. Never put the raw token into an update body.
 const fields=['id','name','status','expired_time','remain_quota','unlimited_quota','model_limits_enabled','model_limits','allow_ips','group','cross_group_retry','subrouter_providers','subrouter_model_providers','subrouter_model_price_limits','include_official_channels','include_shared_subscriptions','include_provider_self','include_cache_hit_rate','subrouter_route_preference'];
 const payload=Object.fromEntries(fields.filter(k=>Object.hasOwn(t,k)).map(k=>[k,t[k]]));await call('/api/token/','PUT',{...payload,...changes});return this.read(t.id);
 },async setStatus(t,status){if(![1,2].includes(status))throw unavailable();await call('/api/token/?status_only=true','PUT',{id:t.id,status});const result=await this.read(t.id);if(result.status!==status)throw unavailable();return result;}});
}
export function nativeRateSnapshot(catalog,routes){const rates={};for(const route of routes){if(rates[route.model])continue;const m=catalog.models.find(x=>x.model_name===route.model),r=m?.apiwild_selling_price,s=m?.[route.supplierRole||'primary'];if(!r?.approved||r.currency!=='USD'||r.processing!=='standard'||s?.supplier_slug!==route.supplierSlug||s.supplier_currency!=='CNY')throw unavailable();rates[route.model]={input:Math.round(r.input*1e6),output:Math.round(r.output*1e6),provider:route.supplierSlug,supplierInput:s.supplier_input,supplierOutput:s.supplier_output};}if(!Object.keys(rates).length)throw unavailable();return rates;}
export function nativeReceipt(row,key){
 if(row.type!==2||row.token_id!==key.token_id||row.user_id!==key.account_id)throw unavailable();
 const other=typeof row.other==='string'?JSON.parse(row.other):row.other,rate=key.rates[row.model_name];
 if(!rate||other?.provider_slug!==rate.provider||other.billing_source!=='wallet')throw unavailable();
 for(const v of [row.id,row.user_id,row.token_id,row.created_at,row.quota,row.prompt_tokens,row.completion_tokens])exactInteger(v,0);
 exactInteger(row.prompt_tokens,0,10000000);exactInteger(row.completion_tokens,0,10000000);
 return {id:row.id,account:row.user_id,token:row.token_id,created:row.created_at,model:row.model_name,provider:other.provider_slug,prompt:row.prompt_tokens,completion:row.completion_tokens,quota:row.quota};
}
export function nativeRetailMicros(fact,rates){const r=rates[fact.model];if(!r)throw unavailable();return Number((BigInt(fact.prompt)*BigInt(r.input)+BigInt(fact.completion)*BigInt(r.output)+999999n)/1000000n);}
export function nativeAllowance(available,rates,costBased=false){
 exactInteger(available,0,1000000000000);const reserve=Math.min(available,1000000);
 if(costBased){const quota=Math.floor(reserve/10);return {quota,reserveUsdMicros:quota*10,reserveCnyMicros:Math.ceil(quota*68/5)};}
 // Small supplier allowance, with headroom for discounted/cache usage. Actual
 // retail usage still reconciles hourly; this is not a real-time retail cutoff.
 const ratio=Math.max(...Object.values(rates).flatMap(r=>[r.input/1e6/(r.supplierInput/6.8),r.output/1e6/(r.supplierOutput/6.8)]));
 if(!Number.isFinite(ratio)||ratio<=0)throw unavailable();const quota=Math.floor(Math.min(5000,reserve/1e6/ratio/4*500000));
 return {reserveUsdMicros:reserve,quota,reserveCnyMicros:Math.ceil(quota*68/5)};
}
export function createNativeCustomerKeys({env,catalog,verifyOwner,legacyKeys,fetchImpl=fetch,clock=Date.now}){
 if(env.APIWILD_NATIVE_CUSTOMER_KEYS_ENABLED!=='true')return undefined;
 const accountId=Number(env.SUBROUTER_ACCOUNT_USER_ID),expiry=Date.parse(env.APIWILD_NATIVE_KEYS_AUTHORIZATION_EXPIRES_AT);
 if(!Number.isFinite(expiry)||env.APIWILD_BILLING_MODE!=='live')throw unavailable();
 const routes=JSON.parse(env.APIWILD_GATEWAY_ROUTES_JSON),budgets=[...new Set(routes.map(r=>r.providerBudgetId))];if(budgets.length!==1)throw unavailable();
 const rates=nativeRateSnapshot(catalog,routes),native=createNativeTokenClient({accessToken:env.SUBROUTER_ACCOUNT_ACCESS_TOKEN,accountId,fetchImpl});
 const conversion=createSupplierConversionGuard({conversion:JSON.parse(env.APIWILD_SUPPLIER_CONVERSION_JSON),fetchImpl,clock});
 if(conversion.conversion.price!=='6.8')throw unavailable();
 async function rpc(name,args){try{return await boundedNativeJson(await fetchImpl(SUPABASE_ORIGIN+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(20000)}));}catch{throw unavailable();}}
 async function owner(authorization){const c=await verifyOwner({authorization});if(c.billingMode!=='live')throw unavailable();return 'live:supabase:'+c.customerId;}
 const tokenFields=(name,expires)=>({name,status:1,remain_quota:0,unlimited_quota:false,expired_time:Math.floor(expires/1000),model_limits_enabled:true,model_limits:Object.keys(rates).join(','),group:'subrouter',cross_group_retry:false,include_official_channels:false,include_shared_subscriptions:false,include_provider_self:true,include_cache_hit_rate:false,subrouter_providers:[...new Set(Object.values(rates).map(r=>r.provider))].join(','),subrouter_model_providers:JSON.stringify(Object.fromEntries(Object.entries(rates).map(([m,r])=>[m,[r.provider]])))});
 function verifyToken(t,row){if(t.name!==row.token_name||t.unlimited_quota!==false||t.model_limits_enabled!==true||t.group!=='subrouter'||t.include_official_channels!==false||t.include_shared_subscriptions!==false||t.cross_group_retry!==false)throw unavailable();const models=t.model_limits.split(',').sort(),expected=Object.keys(row.rates).sort();if(JSON.stringify(models)!==JSON.stringify(expected))throw unavailable();const map=JSON.parse(t.subrouter_model_providers);for(const m of expected)if(JSON.stringify(map[m])!==JSON.stringify([row.rates[m].provider]))throw unavailable();}
 const manager={rpc,native,rates,expiry,accountId,verifyToken,assertConversion:()=>conversion.assertConversion(),async billingPolicy(){return rpc('apiwild_customer_billing_policy',{});},
 async list({authorization}){const own=await owner(authorization),rows=await rpc('apiwild_native_key_rows',{p_owner:own}),keys=await legacyKeys.list({authorization});return keys.map(k=>{const n=rows.find(r=>r.key_id===k.id);return n?{...k,issuer:'subrouter',baseUrl:ORIGIN+'/v1',lastSyncedAt:n.last_synced_at,provisioningPending:n.token_id===null}:k;});},
 async issue(raw){const own=await owner(raw.authorization);for(const v of [raw.dailyLimitUsdMicros,raw.totalLimitUsdMicros])if(v!==null)exactInteger(v,0,1000000000000);if(raw.dailyLimitUsdMicros!==null&&raw.totalLimitUsdMicros!==null&&raw.dailyLimitUsdMicros>raw.totalLimitUsdMicros)throw new GatewayError('native_invalid_limits',400);
 const end=raw.expiresAt===null?expiry:Math.min(Date.parse(raw.expiresAt),expiry);if(!Number.isFinite(end)||end<=clock())throw new GatewayError('native_invalid_expiry',400);
 const id=randomUUID(),name='aw-'+id.replaceAll('-','').slice(0,24);
 const metadata=await rpc('apiwild_native_key_prepare',{p_owner:own,p_id:id,p_hash:createHash('sha256').update(randomBytes(32)).digest('hex'),p_daily:raw.dailyLimitUsdMicros,p_total:raw.totalLimitUsdMicros,p_expires:new Date(end).toISOString(),p_budget:budgets[0],p_account:accountId,p_rates:rates});
 await native.call('/api/token/','POST',tokenFields(name,end));const t=await native.find(name);verifyToken(t,{token_name:name,rates});if(t.remain_quota!==0||t.used_quota!==0)throw unavailable();
 const key=typeof t.key==='string'?(t.key.startsWith('sk-')?t.key:'sk-'+t.key):'';if(!/^sk-[A-Za-z0-9_-]{32,128}$/.test(key))throw unavailable();
 await rpc('apiwild_native_key_attach',{p_owner:own,p_id:id,p_token:t.id});
 // New keys start with zero quota. The worker allocates only against funded USD.
 return {key,metadata:{...metadata,issuer:'subrouter',baseUrl:ORIGIN+'/v1'},baseUrl:ORIGIN+'/v1',billingSync:'hourly'};
 },
 async revoke(raw){const own=await owner(raw.authorization),rows=await rpc('apiwild_native_key_rows',{p_owner:own}),n=rows.find(r=>r.key_id===raw.keyId);if(!n)return legacyKeys.revoke(raw);const run=randomUUID();if(!await rpc('apiwild_native_sync_claim',{p_key:n.key_id,p_run:run}))throw unavailable();try{if(n.token_id){const t=await native.read(n.token_id);verifyToken(t,n);const paused=await native.setStatus(t,2);const stopped=await native.update(paused,{remain_quota:0,expired_time:Math.floor(clock()/1000)-1});if(stopped.status!==2||stopped.remain_quota!==0)throw unavailable();}return await legacyKeys.revoke(raw);}finally{await rpc('apiwild_native_sync_release',{p_key:n.key_id,p_run:run}).catch(()=>{});}}
 };return Object.freeze(manager);
}
