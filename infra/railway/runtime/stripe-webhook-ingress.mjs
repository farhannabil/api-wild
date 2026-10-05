// Explicit server-only configuration. Importing this module or starting the
// preparation CLI never enables a webhook, billing, checkout or inference.
import {strictObject, exactInteger} from './supabase-gateway-rpc.mjs';
import {createStripeFinancialProjection, StripeProjectionError} from './stripe-financial-projection.mjs';
import {createStripeProjectionRpc} from './stripe-projection-rpc.mjs';

export const STRIPE_WEBHOOK_PATH='/api/billing/webhook';
const BODY_MAX=1000000, instances=new WeakSet();
const responseHeaders=Object.freeze({'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
const invalid=(status=400)=>{throw new StripeProjectionError('stripe_invalid_request',status);};
function requestHeaders(request){
  if(request.method!=='POST'||request.url!==STRIPE_WEBHOOK_PATH||request.readableEncoding)invalid();
  const result=Object.create(null);
  for(let i=0;i<request.rawHeaders.length;i+=2){
    const key=request.rawHeaders[i].toLowerCase(),value=request.rawHeaders[i+1];
    if(key.startsWith('oai-authenticated-'))invalid(403);
    if(['stripe-signature','content-type','content-length','transfer-encoding','content-encoding'].includes(key)){
      if(Object.hasOwn(result,key))invalid();result[key]=value;
    }
  }
  if(typeof result['stripe-signature']!=='string'||result['stripe-signature'].length>2048)invalid();
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(result['content-type']||'')||result['content-encoding'])invalid(415);
  if(result['transfer-encoding']!==undefined&&(result['transfer-encoding']!=='chunked'||result['content-length']!==undefined))invalid();
  if(result['content-length']!==undefined){
    if(!/^(?:0|[1-9][0-9]*)$/.test(result['content-length']))invalid();
    if(Number(result['content-length'])>BODY_MAX)invalid(413);
  }
  return result;
}
function readBody(request,timeout,length){
  return new Promise((resolve,reject)=>{
    let bytes=0,settled=false;const chunks=[];
    const finish=(error)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      request.off('data',data);request.off('end',end);request.off('aborted',aborted);request.off('error',aborted);request.off('close',closed);
      if(error){request.pause();reject(error);}else resolve(Buffer.concat(chunks,bytes));
    };
    const data=chunk=>{
      if(!(chunk instanceof Uint8Array)){finish(new StripeProjectionError('stripe_invalid_request',400));return;}
      bytes+=chunk.byteLength;if(bytes>BODY_MAX){finish(new StripeProjectionError('stripe_invalid_request',413));return;}
      chunks.push(Buffer.from(chunk));
    };
    const end=()=>finish(bytes<1||(length!==undefined&&bytes!==Number(length))?new StripeProjectionError('stripe_invalid_request',400):undefined);
    const aborted=()=>finish(new StripeProjectionError('stripe_invalid_request',400));
    const closed=()=>{if(!request.complete)aborted();};
    const timer=setTimeout(()=>finish(new StripeProjectionError('stripe_body_deadline_exceeded',503)),timeout);
    request.on('data',data);request.once('end',end);request.once('aborted',aborted);request.once('error',aborted);request.once('close',closed);
    if(request.aborted||request.destroyed)aborted();
  });
}
function send(response,status,body,close=false){
  if(response.destroyed||response.writableEnded)return;
  const serialized=JSON.stringify(body);
  try{
    response.writeHead(status,{...responseHeaders,'content-length':Buffer.byteLength(serialized),...(close?{connection:'close'}:{})});
    response.end(serialized);
  }catch{response.destroy();} // A disconnected peer cannot create an unhandled rejection.
}

export function isStripeWebhookIngress(value){return instances.has(value);}
export function createStripeWebhookIngress(config={}){
  strictObject(config,['enabled','billingMode','accountId','stripeSecretKey','webhookSecret','supabaseOrigin','supabaseSecretKey','fetchImpl','timeoutMs','rpcTimeoutMs','bodyTimeoutMs','nowSeconds','maxConcurrent']);
  if(config.enabled!==undefined&&typeof config.enabled!=='boolean')throw new StripeProjectionError('stripe_invalid_configuration');
  const enabled=config.enabled===true;
  // Bounded even for unsigned slow/chunked requests. This per-process admission
  // cap is not a substitute for public edge rate limits/real deployment tests.
  const bodyTimeout=exactInteger(config.bodyTimeoutMs??5000,1,5000),maxConcurrent=exactInteger(config.maxConcurrent??4,1,16);
  const projection=enabled?createStripeFinancialProjection({enabled:true,billingMode:config.billingMode,accountId:config.accountId,
    stripeSecretKey:config.stripeSecretKey,webhookSecret:config.webhookSecret,fetchImpl:config.fetchImpl,timeoutMs:config.timeoutMs,
    nowSeconds:config.nowSeconds,project:createStripeProjectionRpc({enabled:true,supabaseOrigin:config.supabaseOrigin,secretKey:config.supabaseSecretKey,
      billingMode:config.billingMode,accountId:config.accountId,fetchImpl:config.fetchImpl,timeoutMs:config.rpcTimeoutMs})}):null;
  let active=0;
  const ingress=Object.freeze({async handle(request,response){
    // Node can emit aborted then error. Keep one harmless listener until the
    // stream ends even when the bounded reader has already removed its hooks.
    request.once('error',()=>{});response.once('error',()=>{});
    if(!enabled||active>=maxConcurrent){send(response,503,{received:false,error:'Webhook unavailable.'},true);return;}
    active++;
    try{
      const headers=requestHeaders(request),rawBody=await readBody(request,bodyTimeout,headers['content-length']);
      const receipt=await projection.handle({rawBody,signature:headers['stripe-signature']});
      // Only the canonical adapter's exact durable receipt can produce 2xx.
      send(response,200,receipt);
    }catch(error){
      const status=error instanceof StripeProjectionError&&[400,403,413,415,422].includes(error.status)?error.status:503;
      send(response,status,{received:false,error:status===503?'Webhook unavailable.':'Invalid webhook request.'},true);
    }finally{active--;}
  }});
  instances.add(ingress);return ingress;
}
