// Normalizes an actual USD-denominated quota debit. This is not a native-CNY
// receipt or a token estimate. The accepted public settings remain immutable.
import {createHash} from 'node:crypto';
import {strictObject,exactInteger,withDeadline} from './supabase-gateway-rpc.mjs';
const fail=()=>Error('supplier_conversion_unverified');
const decimal=/^(?:[1-9][0-9]{0,2}|0)(?:\.[0-9]{1,6})?$/;
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
export function supplierSettingsHash(settings){
 return createHash('sha256').update(JSON.stringify(['subrouter-status-v1',settings.quotaPerUnit,settings.displayCurrency,settings.displayInCurrency,settings.price,settings.usdExchangeRate])).digest('hex');
}
export function validateSupplierConversion(raw){
 strictObject(raw,['quotaPerUnit','displayCurrency','displayInCurrency','price','usdExchangeRate','observedAt','validUntil','settingsSha256']);
 const c={...raw};
 if(c.quotaPerUnit!==500000||c.displayCurrency!=='CNY'||c.displayInCurrency!==true||typeof c.price!=='string'
  ||!decimal.test(c.price)||Number(c.price)<=0||String(Number(c.price))!==c.price||c.price!==c.usdExchangeRate
  ||!iso(c.observedAt)||!iso(c.validUntil)||Date.parse(c.validUntil)<=Date.parse(c.observedAt)
  ||Date.parse(c.validUntil)-Date.parse(c.observedAt)>30*86400000||c.settingsSha256!==supplierSettingsHash(c))throw fail();
 return Object.freeze(c);
}
export function pinSupplierConversion({status,observedAt,validUntil}){
 const c={quotaPerUnit:status?.quota_per_unit,displayCurrency:status?.quota_display_type,displayInCurrency:status?.display_in_currency,
  price:String(status?.price),usdExchangeRate:String(status?.usd_exchange_rate),observedAt,validUntil};
 return validateSupplierConversion({...c,settingsSha256:supplierSettingsHash(c)});
}
export function normalizedQuotaCnyMicros(quota,conversion){
 exactInteger(quota,0,Number.MAX_SAFE_INTEGER);const c=validateSupplierConversion(conversion);
 const [whole,fraction='']=c.usdExchangeRate.split('.'),scale=10n**BigInt(fraction.length);
 const numerator=BigInt(quota)*BigInt(whole+fraction)*1000000n,denominator=BigInt(c.quotaPerUnit)*scale;
 const cost=(numerator+denominator-1n)/denominator;if(cost>1000000000000n)throw fail();return Number(cost);
}
// Fixed origin, no redirects, no retries, bounded JSON even when chunked.
export async function readSubrouterAccountJson(path,{accessToken,accountUserId,fetchImpl=fetch,signal}={}){
 if(path!=='/api/status'&&!/^\/api\/log\/self\?cursor=[A-Za-z0-9%_.~-]{1,1536}&page_size=20$/.test(path))throw fail();
 const url='https://subrouter.ai'+path;let response,reader;
 const cancel=()=>{try{void (reader?.cancel()??response?.body?.cancel())?.catch(()=>{});}catch{}};
 signal?.addEventListener('abort',cancel,{once:true});
 try{
  if(signal?.aborted)throw fail();
  response=await fetchImpl(url,{method:'GET',redirect:'error',cache:'no-store',signal,headers:{accept:'application/json',...(path==='/api/status'?{}:{Authorization:'Bearer '+accessToken,'New-Api-User':String(accountUserId)})}});
  if(signal?.aborted||!(response instanceof Response)||!response.ok||response.redirected||(response.url&&response.url!==url)
   ||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw fail();
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144))throw fail();
  reader=response.body?.getReader();if(!reader)throw fail();let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(signal?.aborted)throw fail();if(done)break;
   if(!(value instanceof Uint8Array)||(size+=value.length)>262144||chunks.length>=4096)throw fail();chunks.push(value);}
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
  if(result?.success!==true||!result.data||typeof result.data!=='object'||Array.isArray(result.data))throw fail();return result.data;
 }finally{signal?.removeEventListener('abort',cancel);cancel();try{reader?.releaseLock();}catch{}}
}
export function createSupplierConversionGuard({conversion,fetchImpl=fetch,clock=Date.now,timeoutMs=5000}){
 const c=validateSupplierConversion(conversion);exactInteger(timeoutMs,1,10000);
 function checkWindow(){const now=clock();if(!Number.isSafeInteger(now)||now<Date.parse(c.observedAt)||now>=Date.parse(c.validUntil))throw fail();}
 return Object.freeze({conversion:c,async assertConversion({signal:parent}={}){
  return withDeadline(async deadline=>{
   const signal=parent?AbortSignal.any([parent,deadline]):deadline;checkWindow();
   const status=await readSubrouterAccountJson('/api/status',{fetchImpl,signal});
   const observed=pinSupplierConversion({status,observedAt:c.observedAt,validUntil:c.validUntil});
   if(observed.settingsSha256!==c.settingsSha256||signal.aborted)throw fail();checkWindow();return true;
  },timeoutMs);
 }});
}
const nativeFields=['quota','quota_unit_currency','quota_per_unit','price','usd_exchange_rate','quota_display_type','display_in_currency',
 'settings_observed_at','settings_valid_until','settings_sha256','log_id','log_created_at','account_user_id','token_id','provider_slug','billing_source','billing_multiplier'];
export function validateNativeDebit(raw,costCnyMicros){
 strictObject(raw,nativeFields);const n=Object.fromEntries(nativeFields.map(k=>[k,raw[k]]));
 for(const key of ['log_id','log_created_at','account_user_id','token_id'])exactInteger(n[key],1,Number.MAX_SAFE_INTEGER);
 if(n.quota_unit_currency!=='USD'||n.billing_source!=='wallet'||n.billing_multiplier!==1||typeof n.provider_slug!=='string'||!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(n.provider_slug))throw fail();
 const conversion=validateSupplierConversion({quotaPerUnit:n.quota_per_unit,displayCurrency:n.quota_display_type,displayInCurrency:n.display_in_currency,
  price:n.price,usdExchangeRate:n.usd_exchange_rate,observedAt:n.settings_observed_at,validUntil:n.settings_valid_until,settingsSha256:n.settings_sha256});
 if(n.log_created_at<Math.floor(Date.parse(conversion.observedAt)/1000)||n.log_created_at>=Math.ceil(Date.parse(conversion.validUntil)/1000)
  ||normalizedQuotaCnyMicros(n.quota,conversion)!==costCnyMicros)throw fail();
 return Object.freeze(n);
}
