// Separate AARO HTTP billing surfaces. Credentials never activate sales by themselves.
import {createAaroStripeProjection} from './aaro-stripe-projection.mjs';
import {createAaroCheckout} from './aaro-checkout.mjs';
import {createAaroUsageRpc,AARO_SUPABASE_ORIGIN} from './aaro-usage-bridge.mjs';
import {boundedJson,STRIPE_ACCOUNTS,StripeProjectionError} from './stripe-financial-projection.mjs';
import {strictObject,withDeadline} from './supabase-gateway-rpc.mjs';
import catalog from '../../../lib/aaro-plans.json' with {type:'json'};
const routes=['/api/aaro/billing','/api/aaro/checkout','/api/aaro/portal','/api/aaro/webhook'];
const rpcNames=new Set(['aaro_billing_customer_v1','aaro_checkout_prepare_v1','aaro_checkout_record_v1','aaro_stripe_binding_read_v1','aaro_stripe_project_v1','aaro_billing_read_v1']);
const instances=new WeakSet(),fail=(status=503)=>{throw Object.assign(new Error('AARO billing unavailable.'),{status});};
const send=(res,status,data)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
function headers(req,webhook){
 const value=Object.create(null),sensitive=new Set(['host','origin','authorization','content-type','content-length','transfer-encoding','content-encoding','stripe-signature','forwarded','x-forwarded-host','x-forwarded-proto']);
 for(let i=0;i<req.rawHeaders.length;i+=2){const name=req.rawHeaders[i].toLowerCase();if(name.startsWith('oai-authenticated-'))fail(403);if(sensitive.has(name)){if(Object.hasOwn(value,name))fail(400);value[name]=req.rawHeaders[i+1];}}
 if(value.host!=='apiwild.com'||value.forwarded!==undefined||value['x-forwarded-proto']!=='https'||value['x-forwarded-host']!==undefined&&value['x-forwarded-host']!=='apiwild.com')fail(403);
 if(!webhook&&value.origin!=='https://apiwild.com')fail(403);
 if(req.readableEncoding||value['content-encoding']!==undefined)fail(415);
 if(value['transfer-encoding']!==undefined&&(value['transfer-encoding']!=='chunked'||value['content-length']!==undefined))fail(400);
 if(value['content-length']!==undefined&&!/^(0|[1-9][0-9]*)$/.test(value['content-length']))fail(400);
 return value;
}
async function body(req,h,max){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(h['content-type']??''))fail(415);
 if(Number(h['content-length']??0)>max)fail(413);
 return new Promise((resolve,reject)=>{
  let size=0,done=false;const chunks=[];
  const finish=error=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('aborted',abort);req.off('error',abort);if(error){req.pause();reject(error);}else resolve(Buffer.concat(chunks,size));};
  const data=chunk=>{if(!(chunk instanceof Uint8Array)){finish(Object.assign(Error(),{status:400}));return;}size+=chunk.byteLength;if(size>max){finish(Object.assign(Error(),{status:413}));return;}chunks.push(Buffer.from(chunk));};
  const end=()=>finish(size<1||h['content-length']!==undefined&&size!==Number(h['content-length'])?Object.assign(Error(),{status:400}):undefined);
  const abort=()=>finish(Object.assign(Error(),{status:400})),timer=setTimeout(()=>finish(Object.assign(Error(),{status:503})),5000);
  req.on('data',data);req.once('end',end);req.once('aborted',abort);req.once('error',abort);if(req.destroyed||req.aborted)abort();
 });
}
export function isAaroBilling(value){return instances.has(value);}
export async function createAaroBillingFromEnv(env={},options={}){
 const fetcher=options.fetchImpl??fetch,mode=env.AARO_BILLING_MODE??'live',secret=env.SUPABASE_SECRET_KEY;
 let rpc,auth,projection,checkout,active=0;
 const readReady=env.AARO_BILLING_ENABLED==='true'&&STRIPE_ACCOUNTS[mode]&&secret&&env.SUPABASE_PUBLISHABLE_KEY;
 const accepted=readReady&&['AARO_FINANCIAL_ACCEPTANCE_VERIFIED','AARO_PROVIDER_ACCEPTANCE_VERIFIED','AARO_WEBHOOK_INGRESS_VERIFIED'].every(key=>env[key]==='true');
 const key=env.STRIPE_SECRET_KEY;
 try{if(readReady){
  // This factory validates secret ownership/shape and provides confirmed Auth.
  auth=createAaroUsageRpc({secretKey:secret,publishableKey:env.SUPABASE_PUBLISHABLE_KEY,fetchImpl:fetcher});
  rpc=async(name,p,{signal=AbortSignal.timeout(12000)}={})=>{
   if(!rpcNames.has(name))fail();const url=AARO_SUPABASE_ORIGIN+'/rest/v1/rpc/'+name;
   const reply=await fetcher(url,{method:'POST',headers:{apikey:secret,...(secret.startsWith('sb_secret_')?{}:{authorization:'Bearer '+secret}),'content-type':'application/json','content-profile':'public'},body:JSON.stringify(p),redirect:'error',cache:'no-store',signal});
   return boundedJson(reply,url,signal);
  };
  if(key&&env.AARO_STRIPE_WEBHOOK_SECRET)projection=createAaroStripeProjection({enabled:true,billingMode:mode,accountId:STRIPE_ACCOUNTS[mode],stripeSecretKey:key,webhookSecret:env.AARO_STRIPE_WEBHOOK_SECRET,fetchImpl:fetcher,rpc});
  if(accepted&&projection&&env.AARO_CHECKOUT_ENABLED==='true'){
   const stripe=options.stripeClient??new (await import('stripe')).default(key,{maxNetworkRetries:0,timeout:12000,apiVersion:'2026-08-26.dahlia'});
   checkout=createAaroCheckout({enabled:true,mode,stripe,rpc,clock:options.clock??Date.now});
  }
 }}catch{rpc=auth=projection=checkout=undefined;}
 const adapter=Object.freeze({matches:path=>routes.includes(path.split('?')[0]),async handle(req,res){
  req.once('error',()=>{});res.once('error',()=>{});
  if(active>=4)return send(res,503,{error:'AARO billing is unavailable.'});active++;
  try{return await withDeadline(async signal=>{
   if(!rpc||req.url.includes('?')||!routes.includes(req.url))fail();const webhook=req.url==='/api/aaro/webhook',h=headers(req,webhook);
   if(webhook){if(req.method!=='POST')fail(405);if(!projection)fail();if(typeof h['stripe-signature']!=='string'||h['stripe-signature'].length>2048)fail(400);
    return send(res,200,await projection.handle({rawBody:await body(req,h,1000000),signature:h['stripe-signature']}));
   }
   if(req.method!==(req.url==='/api/aaro/billing'?'GET':'POST'))fail(405);
   if(!/^Bearer [A-Za-z0-9_.-]{1,4096}$/.test(h.authorization??''))fail(401);
   const customer=await auth.verifyCustomer(h.authorization.slice(7),signal),owner=mode+':supabase:'+customer.id;
   if(req.url==='/api/aaro/billing'){
    const state=await rpc('aaro_billing_read_v1',{p_owner:owner},{signal});if(state.owner!==owner||typeof state.frozen!=='boolean'||!Array.isArray(state.subscriptions)||!Array.isArray(state.creditPeriods))fail();
    // No raw private ledger, supplier identity or unrelated customer data.
    const periods=state.creditPeriods.map(x=>({invoiceId:x.invoiceId,subscriptionId:x.subscriptionId,credits:x.credits,spentCredits:x.spentCredits,reservedCredits:x.reservedCredits,remainingCredits:x.remainingCredits,periodStart:x.periodStart,periodEnd:x.periodEnd,paid:x.paid,frozen:x.frozen}));
    const now=(options.clock??Date.now)(),current=periods.filter(x=>x.paid===true&&x.frozen===false&&Date.parse(x.periodStart)<=now&&Date.parse(x.periodEnd)>now);
    if(current.length>1||current.some(x=>!['credits','spentCredits','reservedCredits','remainingCredits'].every(key=>Number.isSafeInteger(x[key])&&x[key]>=0)||x.credits!==x.spentCredits+x.reservedCredits+x.remainingCredits))fail();
    const usable=accepted&&env.AARO_FINANCE_ENABLED==='true'&&state.frozen===false&&current.length===1&&state.subscriptions.some(x=>x.status==='active'&&x.subscriptionId===current[0].subscriptionId);
    const usage=usable?{available:current[0].remainingCredits,spent:current[0].spentCredits,reserved:current[0].reservedCredits}:null;
    return send(res,200,{enabled:Boolean(checkout),billing:Boolean(checkout)?'enabled':'disabled',usageEnabled:usable,creditBalanceAvailable:usable,usage,bangladeshEligible:state.bangladeshEligible===true,subscriptions:state.subscriptions.map(x=>({plan:x.plan,status:x.status,subscriptionId:x.subscriptionId})),creditPeriods:periods,plans:catalog.plans.map(({id,name,region,currency,amount,credits})=>({id,name,region,currency,amount,credits}))});
   }
   if(!checkout)fail();let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await body(req,h,4096)));}catch(error){if(error.status)throw error;fail(400);}
   strictObject(input,req.url==='/api/aaro/checkout'?['plan','returnTo']:['returnTo']);
   signal.throwIfAborted();const result=await checkout[req.url==='/api/aaro/checkout'?'checkout':'portal'](owner,input,{signal});signal.throwIfAborted();return send(res,200,result);
  },25000);
  }catch(error){const status=[400,401,403,405,413,415,422].includes(error.status)?error.status:503;
   return send(res,status,{error:'AARO billing could not be verified.',creditsGranted:false});
  }finally{active--;}
 }});instances.add(adapter);return adapter;
}
