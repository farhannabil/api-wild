// Explicit operator harness only. Never imported by the production server.
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {createOwnStripeCheckout} from './stripe-checkout.mjs';
import {createStripeFinancialProjection, verifyStripeSignature} from './stripe-financial-projection.mjs';
import {createStripeProjectionRpc} from './stripe-projection-rpc.mjs';
import {createOwnedGatewayFromEnv} from './owned-gateway-assembly.mjs';
import {SUPABASE_ORIGIN, exactInteger, strictObject} from './supabase-gateway-rpc.mjs';
import {validateSupplierConversion} from './subrouter-supplier-conversion.mjs';

export const SANDBOX_OWNER='test:supabase:71ced254-af80-44db-8667-124ef995f095';
export const SANDBOX_ACCOUNT='acct_1UCiHk0SGcPsf6AA';
export const SANDBOX_BUDGET='66830e89-712b-4dba-9f20-750746039d9c';
export const SANDBOX_KEY_REFERENCE='fb051542-0272-489a-b43e-b4c0f85fd57a';
const MODEL='MiniMax-M2.7-highspeed',UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// This is NOT a Stripe credential. Only this harness's fixed CLI transport sees
// it; it is never sent over HTTP. Real sandbox CLI auth performs every Stripe read.
const CLI_MARKER='sk_test_APIWILDLoopbackCLITransportOnly';
const fail=()=>{throw Error('Sandbox acceptance unavailable; inspect the exact existing operation.');};
const digest=value=>createHash('sha256').update(value).digest('hex');
const id=(value,prefix)=>typeof value==='string'&&new RegExp('^'+prefix+'_[A-Za-z0-9]+$').test(value);

export function sandboxConfiguration(env){
  const required=['SUPABASE_SECRET_KEY','SUPABASE_PUBLISHABLE_KEY','APIWILD_SANDBOX_RUN_ID','APIWILD_SANDBOX_PRICE_ID','APIWILD_SANDBOX_ROUTE_JSON','APIWILD_SANDBOX_RETAIL_RATE_VERSION','APIWILD_SANDBOX_UPSTREAM_KEY','APIWILD_SUPPLIER_CONVERSION_JSON','SUBROUTER_ACCOUNT_ACCESS_TOKEN','SUBROUTER_ACCOUNT_USER_ID'];
  const missing=required.filter(name=>!env[name]);if(missing.length)return {configured:false,missing};
  if(!/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(env.SUPABASE_SECRET_KEY)||!/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(env.SUPABASE_PUBLISHABLE_KEY)||!UUID.test(env.APIWILD_SANDBOX_RUN_ID)||!id(env.APIWILD_SANDBOX_PRICE_ID,'price')||!/^sk-[A-Za-z0-9_-]{16,256}$/.test(env.APIWILD_SANDBOX_UPSTREAM_KEY))fail();
  if(typeof env.SUBROUTER_ACCOUNT_ACCESS_TOKEN!=='string'||env.SUBROUTER_ACCOUNT_ACCESS_TOKEN.length<16||env.SUBROUTER_ACCOUNT_ACCESS_TOKEN.length>8192||/[\x00-\x20\x7f]/.test(env.SUBROUTER_ACCOUNT_ACCESS_TOKEN)||!/^[1-9][0-9]{0,15}$/.test(env.SUBROUTER_ACCOUNT_USER_ID))fail();
  exactInteger(Number(env.SUBROUTER_ACCOUNT_USER_ID),1,Number.MAX_SAFE_INTEGER);
  const conversion=validateSupplierConversion(JSON.parse(env.APIWILD_SUPPLIER_CONVERSION_JSON));
  if(Date.now()<Date.parse(conversion.observedAt)||Date.now()>=Date.parse(conversion.validUntil))fail();
  let route;try{route=JSON.parse(env.APIWILD_SANDBOX_ROUTE_JSON);}catch{fail();}
  strictObject(route,['model','upstreamModel','capability','providerBudgetId','supportsTools','maxInputTokens','maxOutputTokens','maxInputChars','supplierReserveCnyMicros','supplierSlug','supplierRole']);
  if(route.model!==MODEL||route.upstreamModel!==MODEL||route.capability!=='chat'||route.providerBudgetId!==SANDBOX_BUDGET||route.supplierSlug!=='leapnode'||(route.supplierRole!==undefined&&route.supplierRole!=='primary')||(route.supportsTools!==undefined&&route.supportsTools!==false)||env.APIWILD_SANDBOX_RETAIL_RATE_VERSION!=='apiwild-launch-20261005')fail();
  exactInteger(route.maxInputTokens,256,512);exactInteger(route.maxOutputTokens,128,128);exactInteger(route.maxInputChars,256,512);exactInteger(route.supplierReserveCnyMicros,1,10000);
  return {configured:true,route,runId:env.APIWILD_SANDBOX_RUN_ID};
}
function fields(value,prefix=''){
  if(Array.isArray(value))return value.flatMap((v,i)=>fields(v,prefix+'['+i+']'));
  if(value&&typeof value==='object')return Object.entries(value).flatMap(([k,v])=>fields(v,prefix?prefix+'['+k+']':k));
  if(!['string','number','boolean'].includes(typeof value))fail();return [prefix+'='+String(value)];
}
export function createSandboxStripeCli(runStripe){
  if(typeof runStripe!=='function')fail();
  async function request(method,path,data,idem){
    if(!['get','post'].includes(method)||!/^\/v1\/(?:account|prices\/price_[A-Za-z0-9]+|customers|checkout\/sessions(?:\/cs_test_[A-Za-z0-9]+)?|payment_intents\/pi_[A-Za-z0-9]+(?:\/confirm)?|refunds(?:\/re_[A-Za-z0-9]+)?|charges\/ch_[A-Za-z0-9]+|disputes\/dp_[A-Za-z0-9]+)$/.test(path))fail();
    if(method==='post'&&!['/v1/customers','/v1/checkout/sessions','/v1/refunds'].includes(path))fail();
    const args=[method,path,'--stripe-version','2026-08-26.dahlia'];
    if(method==='post'){if(typeof idem!=='string'||!/^[A-Za-z0-9_-]{16,160}$/.test(idem))fail();args.push('--confirm','--idempotency',idem);}
    for(const field of fields(data??{}))args.push('-d',field);
    const value=await runStripe(args);if(!value||typeof value!=='object'||Array.isArray(value)||value.error)fail();return value;
  }
  return Object.freeze({request,client:{accounts:{retrieve:()=>request('get','/v1/account')},prices:{retrieve:price=>request('get','/v1/prices/'+price)},checkout:{sessions:{create:(data,options)=>request('post','/v1/checkout/sessions',data,options.idempotencyKey)}}}});
}

export function createSandboxE2eHarness({env,catalog,runStripe,fetchImpl=fetch,checkpoint,write=()=>{}}){
  const config=sandboxConfiguration(env);if(!config.configured||env.APIWILD_SANDBOX_E2E_ENABLED!=='true'||typeof checkpoint!=='function')fail();
  env={...env};
  const stripe=createSandboxStripeCli(runStripe),attempted=new Set();let busy=false,checkout,baseline,customerKey,keyId,keyRevoked=false,completion,paymentIntent,projection,requestId;
  const summaries={};
  const phase=async(name,work)=>{if(busy||attempted.has(name))fail();busy=true;attempted.add(name);try{await checkpoint({phase:name,state:'attempted',runId:config.runId});const result=await work();summaries[name]=result;await checkpoint({phase:name,state:'finished',runId:config.runId,result});return result;}finally{busy=false;}};
  const json=async response=>{if(!response.ok||response.redirected||!/^application\/json/.test(response.headers.get('content-type')??''))fail();const reader=response.body?.getReader();if(!reader)fail();let count=0;const chunks=[];try{for(;;){const part=await reader.read();if(part.done)break;if((count+=part.value.length)>1048576)fail();chunks.push(part.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}};
  const rpc=async(name,body)=>json(await fetchImpl(SUPABASE_ORIGIN+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:env.SUPABASE_SECRET_KEY,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)}));
  const transport=async(url,init={})=>{
    const target=new URL(url);
    if(target.origin==='https://api.stripe.com'){
      if(init.method!=='GET'||init.headers?.authorization!=='Bearer '+CLI_MARKER)fail();
      const value=await stripe.request('get',target.pathname,Object.fromEntries(target.searchParams));return Response.json(value);
    }
    if(![SUPABASE_ORIGIN,'https://subrouter.ai'].includes(target.origin))fail();
    if(target.origin===SUPABASE_ORIGIN&&target.pathname==='/rest/v1/rpc/apiwild_gateway_claim'){
      // The owned RPC adapter already validated this reserved record. Persist
      // its identity before a claim can permit paid dispatch, even if HTTP fails.
      const claim=JSON.parse(init.body);if(claim.p_owner!==SANDBOX_OWNER||!UUID.test(claim.p_id)||(requestId&&requestId!==claim.p_id))fail();
      requestId=claim.p_id;await checkpoint({phase:'model-request',state:'reserved',runId:config.runId,requestId});
    }
    return fetchImpl(url,init);
  };
  const gateway=createOwnedGatewayFromEnv({env:{APIWILD_OWNED_GATEWAY_ENABLED:'true',APIWILD_BILLING_MODE:'test',APIWILD_INFERENCE_ENABLED:'true',SUPABASE_SECRET_KEY:env.SUPABASE_SECRET_KEY,SUPABASE_PUBLISHABLE_KEY:env.SUPABASE_PUBLISHABLE_KEY,SUBROUTER_API_KEY:env.APIWILD_SANDBOX_UPSTREAM_KEY,APIWILD_GATEWAY_ROUTES_JSON:JSON.stringify([config.route]),APIWILD_RETAIL_RATE_VERSION:env.APIWILD_SANDBOX_RETAIL_RATE_VERSION,APIWILD_SUPPLIER_CONVERSION_JSON:env.APIWILD_SUPPLIER_CONVERSION_JSON},catalog,fetchImpl:transport});
  const account=async()=>{const value=await stripe.request('get','/v1/account');if(value.id!==SANDBOX_ACCOUNT)fail();};
  const usage=()=>rpc('apiwild_gateway_usage',{p_owner:SANDBOX_OWNER});
  const revoke=async()=>{if(keyId&&!keyRevoked){const row=await rpc('apiwild_gateway_key_revoke',{p_owner:SANDBOX_OWNER,p_id:keyId});if(row.id!==keyId||!row.revoked_at)fail();keyRevoked=true;}customerKey=undefined;};
  return Object.freeze({
    gateway,
    status:()=>({runId:config.runId,ownerMode:'test',requestId,attempted:[...attempted],completed:Object.keys(summaries),checkoutReady:Boolean(checkout),modelFinished:Boolean(completion)}),
    checkoutUrl:()=>checkout?.url,
    requestId:()=>requestId,
    setWebhookSecret(secret){
      if(projection||!/^whsec_[A-Za-z0-9]{16,256}$/.test(secret))fail();
      const project=createStripeProjectionRpc({enabled:true,supabaseOrigin:SUPABASE_ORIGIN,secretKey:env.SUPABASE_SECRET_KEY,billingMode:'test',accountId:SANDBOX_ACCOUNT,fetchImpl});
      projection={secret,handler:createStripeFinancialProjection({enabled:true,billingMode:'test',accountId:SANDBOX_ACCOUNT,stripeSecretKey:CLI_MARKER,webhookSecret:secret,fetchImpl:transport,project:async(name,params,options)=>{
        if(!checkout||params.p_fact.order_id!==checkout.orderId)fail();return project(name,params,options);
      }})};
    },
    async webhook(rawBody,signature){
      if(!projection||!verifyStripeSignature(rawBody,signature,projection.secret))fail();
      const receipt=await projection.handler.handle({rawBody,signature});write({event:'signed-sandbox-projection',received:receipt.received,replayed:receipt.replayed});return receipt;
    },
    createCheckout:()=>phase('create-checkout',async()=>{
      if(!projection)fail();await account();
      const initialized=await rpc('apiwild_gateway_account_initialize',{p_owner:SANDBOX_OWNER});if(initialized.initialized!==true||initialized.billing_mode!=='test'||initialized.customer_id!==SANDBOX_OWNER.split(':')[2])fail();
      baseline=await usage();exactInteger(baseline.fundedUsdMicros);
      const client=createOwnStripeCheckout({enabled:true,billingMode:'test',accountId:SANDBOX_ACCOUNT,priceId:env.APIWILD_SANDBOX_PRICE_ID,stripeClient:stripe.client,register:rpc,resolveCustomer:async()=>{
        const old=await rpc('apiwild_stripe_customer',{p_owner:SANDBOX_OWNER});if(old.customerId)return old.customerId;
        const created=await stripe.request('post','/v1/customers',{metadata:{apiwild_owner:SANDBOX_OWNER}},'apiwild-sandbox-customer-'+digest(SANDBOX_OWNER));if(!id(created.id,'cus'))fail();
        const bound=await rpc('apiwild_stripe_customer',{p_owner:SANDBOX_OWNER,p_customer:created.id});if(bound.customerId!==created.id)fail();return bound.customerId;
      }});
      checkout=await client.checkout(SANDBOX_OWNER,{amountCents:3000,requestId:config.runId});return {orderId:checkout.orderId,creditsGranted:false,checkoutReady:true};
    }),
    async paymentStatus(){
      if(!checkout||!baseline)fail();
      const info=await rpc('apiwild_billing_read',{p_owner:SANDBOX_OWNER});const order=info.orders?.find(o=>o.id===checkout.orderId);
      const current=await usage();return {paid:order?.status==='paid'&&current.fundedUsdMicros===baseline.fundedUsdMicros+30000000,orderId:checkout.orderId,fundedUsdMicros:current.fundedUsdMicros,baselineFundedUsdMicros:baseline.fundedUsdMicros};
    },
    runModel:callGateway=>phase('run-model',async()=>{
      if(!checkout||!baseline||typeof callGateway!=='function')fail();
      const info=await rpc('apiwild_billing_read',{p_owner:SANDBOX_OWNER}),before=await usage();
      if(!info.orders?.some(o=>o.id===checkout.orderId&&o.status==='paid')||before.fundedUsdMicros!==baseline.fundedUsdMicros+30000000||info.suspended!==false)fail();
      customerKey='aw_test_'+randomBytes(32).toString('hex');keyId=randomUUID();
      const issued=await rpc('apiwild_gateway_key_issue',{p_owner:SANDBOX_OWNER,p_id:keyId,p_hash:digest(customerKey),p_scopes:['chat'],p_daily_limit:1000000,p_total_limit:1000000,p_expires_at:new Date(Date.now()+1800000).toISOString()});
      if(issued.id!==keyId||issued.billing_mode!=='test'||issued.customer_id!==SANDBOX_OWNER.split(':')[2])fail();
      const body={model:MODEL,messages:[{role:'user',content:'Reply with exactly OK.'}],max_tokens:128,stream:false};
      const value=await callGateway({authorization:'Bearer '+customerKey,requestKey:'sandbox_'+config.runId.replaceAll('-',''),body});
      if(value.status!==200||!UUID.test(value.body?.id)||value.body.object!=='chat.completion'||value.body.model!==MODEL||!Array.isArray(value.body.choices)||typeof value.body.choices[0]?.message?.content!=='string')fail();
      if(requestId&&requestId!==value.body.id)fail();completion=value.body;requestId=completion.id;const after=await usage();
      if(after.completedRequests!==before.completedRequests+1||after.spentUsdMicros<=before.spentUsdMicros)fail();
      return {requestId:completion.id,model:MODEL,completedRequests:after.completedRequests,retailDebitUsdMicros:after.spentUsdMicros-before.spentUsdMicros,usage:completion.usage,responseReceived:completion.choices[0].message.content.trim().length>0,supplierReconciliationRequired:true};
    }),
    replay:callGateway=>phase('replay',async()=>{
      if(!completion||!customerKey)fail();const before=await usage();const value=await callGateway({authorization:'Bearer '+customerKey,requestKey:'sandbox_'+config.runId.replaceAll('-',''),body:{model:MODEL,messages:[{role:'user',content:'Reply with exactly OK.'}],max_tokens:128,stream:false}});const after=await usage();
      if(value.status!==200||JSON.stringify(value.body)!==JSON.stringify(completion)||JSON.stringify(before)!==JSON.stringify(after))fail();return {replayMatched:true,unchangedUsage:true,requestId:completion.id};
    }),
    reconcile:reconciler=>phase('reconcile',async()=>{if(!requestId||typeof reconciler?.reconcile!=='function')fail();const result=await reconciler.reconcile({owner:SANDBOX_OWNER,requestId});if(result.reconciled!==true||result.held!==false)fail();return {requestId,reconciled:true};}),
    refund:()=>phase('refund',async()=>{
      if(!checkout||!summaries.reconcile)fail();await account();
      // A full refund after consumed test credit can suspend this test wallet.
      // Revoke first, while the customer-scoped revoke RPC remains available.
      await revoke();
      const info=await rpc('apiwild_billing_read',{p_owner:SANDBOX_OWNER}),order=info.orders?.find(o=>o.id===checkout.orderId);if(!order||!id(order.session_id,'cs_test'))fail();
      const session=await stripe.request('get','/v1/checkout/sessions/'+order.session_id);if(session.livemode!==false||session.metadata?.order_id!==checkout.orderId||session.payment_status!=='paid'||!id(session.payment_intent,'pi'))fail();paymentIntent=session.payment_intent;
      const result=await stripe.request('post','/v1/refunds',{payment_intent:paymentIntent},'apiwild-sandbox-refund-'+config.runId);if(!id(result.id,'re')||result.payment_intent!==paymentIntent)fail();return {refundRequested:true,refundId:result.id,creditReversalRequiresSignedEvent:true};
    }),
    async refundStatus(){if(!summaries.refund||!baseline)fail();const info=await rpc('apiwild_billing_read',{p_owner:SANDBOX_OWNER}),current=await usage().catch(()=>null);return {orderRefunded:info.orders?.find(o=>o.id===checkout.orderId)?.status==='refunded',fundedReturnedToBaseline:current?current.fundedUsdMicros===baseline.fundedUsdMicros:null,suspended:info.suspended};},
    close:()=>phase('close',async()=>{await revoke();return {testKeyRevoked:keyRevoked,financialRecordsPreserved:true};}),
  });
}
