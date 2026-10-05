// Official Sub-Router frontend commit 5303cd51, src/api.js and pages/Topup.jsx.
// Native station owns payment fulfillment and quota. This adapter never writes
// a Supabase balance or grants credit from a checkout URL/return-page parameter.
import {NATIVE_STATION_ORIGIN,NativeCustomerError} from './subrouter-native-customer.mjs';
export const MINIMUM_TOPUP_CENTS=3000;
const RETURN_URL='https://apiwild.com/api-account/billing?payment=return';
const fail=(code,status=503)=>{throw new NativeCustomerError(code,status);};
const cancel=value=>{try{Promise.resolve(value?.cancel()).catch(()=>{});}catch{}};
const scalar=(record,fields)=>Object.fromEntries(fields.filter(key=>Object.hasOwn(record,key)&&(record[key]===null||['string','boolean'].includes(typeof record[key])||typeof record[key]==='number'&&Number.isFinite(record[key]))).map(key=>[key,record[key]]));
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function createNativeBilling(config={}){
 const allowed=['enabled','nativeCheckoutEnabled','stationOrigin','userId','sessionCookie','fetchImpl','timeoutMs'];
 if(!object(config)||Object.keys(config).some(key=>!allowed.includes(key))||['enabled','nativeCheckoutEnabled'].some(key=>config[key]!==undefined&&typeof config[key]!=='boolean'))fail('native_billing_invalid_configuration');
 const enabled=config.enabled===true,checkoutEnabled=config.nativeCheckoutEnabled===true;
 const {userId,sessionCookie}=config,fetchImpl=config.fetchImpl??fetch,timeout=config.timeoutMs??10000;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>10000)fail('native_billing_invalid_configuration');
 if(enabled&&(config.stationOrigin!==NATIVE_STATION_ORIGIN||!Number.isSafeInteger(userId)||userId<1||typeof sessionCookie!=='string'||!sessionCookie.length||sessionCookie.length>8192||/[\x00-\x1f\x7f]/.test(sessionCookie)||typeof fetchImpl!=='function'))fail('native_billing_invalid_configuration');
 async function transport(path,method='GET',body){
  const controller=new AbortController();let response,reader,timer;
  const deadline=new Promise((_,reject)=>timer=setTimeout(()=>{controller.abort();cancel(reader??response?.body);reject(new NativeCustomerError('native_billing_timeout'));},timeout));
  const work=(async()=>{
   const url=NATIVE_STATION_ORIGIN+path,headers={cookie:sessionCookie,'New-Api-User':String(userId),accept:'application/json'};
   if(body)headers['content-type']='application/json';
   response=await fetchImpl(url,{method,headers,body:body?JSON.stringify(body):undefined,redirect:'error',cache:'no-store',signal:controller.signal});
   if(controller.signal.aborted||!(response instanceof Response)||response.redirected||(response.url&&response.url!==url))fail('native_billing_invalid_response');
   if(!response.ok)fail(response.status===401?'native_session_required':'native_billing_unavailable',response.status===401?401:503);
   if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))fail('native_billing_invalid_response');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>65536))fail('native_billing_invalid_response');
   reader=response.body?.getReader();if(!reader)fail('native_billing_invalid_response');let bytes=0;const chunks=[];
   while(true){const {done,value}=await reader.read();if(controller.signal.aborted)fail('native_billing_timeout');if(done)break;if(!(value instanceof Uint8Array)||(bytes+=value.byteLength)>65536||chunks.length>=4096)fail('native_billing_invalid_response');chunks.push(value);}
   const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
   // Native auth uses success:true; native Stripe checkout uses message:success.
   if(!object(envelope)||(envelope.success!==true&&envelope.message!=='success')||envelope.success===false||!Object.hasOwn(envelope,'data'))fail('native_billing_unavailable');
   return envelope.data;
  })();
  try{return await Promise.race([work,deadline]);}catch(error){if(error instanceof NativeCustomerError)throw error;fail('native_billing_unavailable');}
  finally{clearTimeout(timer);controller.abort();cancel(reader??response?.body);try{reader?.releaseLock();}catch{}}
 }
 async function identity(){if(!enabled)fail('native_billing_disabled');const self=await transport('/api/dist/user/self');if(!object(self)||self.id!==userId)fail('native_owner_mismatch',403);}
 async function info(){const data=await transport('/api/dist/topup/info');if(!object(data))fail('native_billing_invalid_response');return data;}
 function presentation(data){
  const configured=data.currency==='USD'&&data.exchange_rate===1&&data.enable_stripe_topup===true&&Number.isFinite(data.stripe_min_topup)&&data.stripe_min_topup>0&&data.stripe_min_topup<=250&&Array.isArray(data.pay_methods)&&data.pay_methods.some(method=>method?.type==='stripe');
  return {authority:'subrouter-native-station',currency:typeof data.currency==='string'?data.currency:null,checkoutEnabled:checkoutEnabled&&configured,
   minimumTopupUsd:MINIMUM_TOPUP_CENTS/100,stripeConfigured:configured,stripeMinTopup:Number.isFinite(data.stripe_min_topup)?data.stripe_min_topup:null,
   amountTiers:Array.isArray(data.amount_tiers)?data.amount_tiers.slice(0,50).filter(object).map(tier=>scalar(tier,['amount','bonus'])):[],
   creditsGranted:false};
 }
 return Object.freeze({
  async read(operation){
   if(!['info','history'].includes(operation))fail('native_billing_unknown_operation',400);await identity();
   if(operation==='info')return presentation(await info());
   const data=await transport('/api/dist/topup/history?page=1&page_size=20');
   if(!object(data)||!Array.isArray(data.items)||data.items.length>20)fail('native_billing_invalid_response');
   return {authority:'subrouter-native-station',items:data.items.map(item=>{if(!object(item))fail('native_billing_invalid_response');return scalar(item,['id','trade_no','amount','display_amount','currency','bonus_amount','credited_quota','create_time','payment_method','status']);}),creditsGranted:false};
  },
  async checkout(input){
   if(!enabled||!checkoutEnabled)fail('native_checkout_disabled');
   if(!object(input)||Object.keys(input).some(key=>!['amountCents','currency'].includes(key))||input.currency!=='USD'||!Number.isSafeInteger(input.amountCents)||input.amountCents<MINIMUM_TOPUP_CENTS||input.amountCents>25000)fail('native_billing_invalid_request',400);
   await identity();const configuration=await info(),status=presentation(configuration);
   // No inferred currency conversion or tier bonus. The station must explicitly
   // support USD and its exact 1:1 payment-unit rate before checkout is exposed.
   if(!status.checkoutEnabled||!Number.isFinite(status.stripeMinTopup)||status.stripeMinTopup<=0||input.amountCents<Math.ceil(status.stripeMinTopup*100))fail('native_checkout_not_configured');
   const data=await transport('/api/dist/topup/stripe/pay','POST',{amount:input.amountCents/100,payment_method:'stripe',currency:'USD',return_url:RETURN_URL});
   if(!object(data)||typeof data.pay_link!=='string'||data.pay_link.length>2048)fail('native_checkout_receipt_unavailable');
   let link;try{link=new URL(data.pay_link);}catch{fail('native_checkout_receipt_unavailable');}
   if(link.origin!=='https://checkout.stripe.com'||link.username||link.password||!link.pathname.startsWith('/c/'))fail('native_checkout_receipt_unavailable');
   return Object.freeze({authority:'subrouter-native-station',url:link.href,creditsGranted:false});
  },
 });
}
