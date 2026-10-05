import {createHash} from 'node:crypto';
import {createOwnStripeCheckout} from './stripe-checkout.mjs';
import {createStripeWebhookIngress} from './stripe-webhook-ingress.mjs';
import {SUPABASE_ORIGIN} from './supabase-gateway-rpc.mjs';
import {STRIPE_ACCOUNTS} from './stripe-financial-projection.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const routes=['/api/billing','/api/billing/checkout','/api/billing/reconcile','/api/billing/webhook'];
const error=(status=503)=>Object.assign(new Error('Billing unavailable.'),{status});
async function json(response,max=65536){if(!response.ok||response.redirected||!/^application\/json/.test(response.headers.get('content-type')||''))throw error();const reader=response.body.getReader();let n=0;const chunks=[];try{while(true){const x=await reader.read();if(x.done)break;n+=x.value.length;if(n>max)throw error();chunks.push(x.value)}return JSON.parse(Buffer.concat(chunks,n).toString('utf8'))}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}}
function send(res,status,data){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))}
export async function createOwnedBillingFromEnv(env,{fetchImpl=fetch,stripeClient}={}){
 const enabled=env.OWN_BILLING_ENABLED==='true',mode=env.BILLING_MODE||'live',account=STRIPE_ACCOUNTS[mode],secret=env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY,apiKey=env.STRIPE_SECRET_KEY;
 let stripe,checkout,webhook;
 const readReady=enabled&&account&&secret;
 const ready=readReady&&apiKey&&env.STRIPE_WEBHOOK_SECRET&&env.STRIPE_CREDIT_PRICE_ID;
 // Credential entry enables signed fulfillment, never credit sales by itself.
 // Release this separate switch only after bounded delivery acceptance.
 const checkoutReady=ready&&env.APIWILD_CHECKOUT_ENABLED==='true';
 const call=async(path,body)=>json(await fetchImpl(SUPABASE_ORIGIN+path,{method:body?'POST':'GET',headers:{apikey:secret,...(secret?.startsWith('sb_secret_')?{}:{authorization:'Bearer '+secret}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(12000)}));
 const rpc=(name,p)=>call('/rest/v1/rpc/'+name,p);
 if(ready){
  if(!new RegExp('^(sk|rk)_'+mode+'_[A-Za-z0-9]+$').test(apiKey))throw error();
  stripe=stripeClient??new (await import('stripe')).default(apiKey,{maxNetworkRetries:0,timeout:15000});
  if(checkoutReady)checkout=createOwnStripeCheckout({enabled:true,billingMode:mode,accountId:account,priceId:env.STRIPE_CREDIT_PRICE_ID,stripeClient:stripe,register:rpc,resolveCustomer:async owner=>{
   const existing=await rpc('apiwild_stripe_customer',{p_owner:owner});if(existing.customerId)return existing.customerId;
   const created=await stripe.customers.create({metadata:{apiwild_owner:owner}},{idempotencyKey:'apiwild-owner-'+createHash('sha256').update(owner).digest('hex')});
   const bound=await rpc('apiwild_stripe_customer',{p_owner:owner,p_customer:created.id});return bound.customerId;
  }});
  webhook=createStripeWebhookIngress({enabled:true,billingMode:mode,accountId:account,stripeSecretKey:apiKey,webhookSecret:env.STRIPE_WEBHOOK_SECRET,supabaseOrigin:SUPABASE_ORIGIN,supabaseSecretKey:secret,fetchImpl});
 }
 return Object.freeze({matches:path=>routes.includes(path.split('?')[0]),async handle(req,res){
  const url=new URL(req.url,'https://apiwild.com'),path=url.pathname;
  if(path==='/api/billing/webhook'){if(!webhook)return send(res,503,{error:'Payments are not activated.'});return webhook.handle(req,res)}
  try{
   if(!readReady)throw error();
   if(Object.keys(req.headers).some(k=>k.startsWith('oai-authenticated-')))throw error(403);
   if(req.method!=='GET'&&req.headers.origin!=='https://apiwild.com')throw error(403);
   const auth=req.headers.authorization;if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(auth))throw error(401);
   const authResponse=await fetchImpl(SUPABASE_ORIGIN+'/auth/v1/user',{headers:{apikey:env.SUPABASE_ANON_KEY||secret,authorization:auth},redirect:'error',signal:AbortSignal.timeout(10000)});
   if([401,403].includes(authResponse.status)){await authResponse.body?.cancel().catch(()=>{});throw error(401)}
   const user=await json(authResponse);
   if(!uuid.test(user.id)||!user.email_confirmed_at||user.is_anonymous===true)throw error(401);const owner=mode+':supabase:'+user.id;
   const initialized=await rpc('apiwild_gateway_account_initialize',{p_owner:owner});if(initialized.initialized!==true||initialized.customer_id!==user.id||initialized.billing_mode!==mode)throw error();
   if(path==='/api/billing'&&req.method==='GET'){const info=await rpc('apiwild_billing_read',{p_owner:owner});return send(res,200,{...info,checkoutEnabled:Boolean(checkoutReady)&&info.suspended===false,minimumTopupCents:3000})}
   if(path==='/api/billing/reconcile'&&req.method==='GET'){const session=url.searchParams.get('sessionId');if(!new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$').test(session||''))throw error(400);return send(res,200,await rpc('apiwild_billing_read',{p_owner:owner,p_session:session}))}
   if(path!=='/api/billing/checkout'||req.method!=='POST')throw error(405);
   if(!checkout)throw error();
   const financialState=await rpc('apiwild_billing_read',{p_owner:owner});if(financialState.suspended!==false)throw error(403);
   if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw error(415);
   const chunks=[];let size=0;const timeout=setTimeout(()=>req.destroy(),5000);let input;
   try{for await(const c of req){size+=c.length;if(size>4096)throw error(413);chunks.push(c)}input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}finally{clearTimeout(timeout)}
   return send(res,200,await checkout.checkout(owner,input));
  }catch(e){send(res,[400,401,403,405,413,415].includes(e.status)?e.status:503,{error:'Billing unavailable. No credits were granted.'})}
 }});
}
