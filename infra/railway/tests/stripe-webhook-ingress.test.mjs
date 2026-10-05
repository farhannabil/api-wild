// Offline HTTP on fresh loopback ephemeral servers + injected synthetic
// Stripe/Supabase responses. No environment keys, real payments or production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {connect} from 'node:net';
import {createHmac} from 'node:crypto';
import {createPreparationServer,preparationResponse} from '../preparation-server.mjs';
import {createStripeWebhookIngress,STRIPE_WEBHOOK_PATH} from '../runtime/stripe-webhook-ingress.mjs';
import {STRIPE_ACCOUNTS,PROJECTION_RPC} from '../runtime/stripe-financial-projection.mjs';
import {SUPABASE_ORIGIN} from '../runtime/supabase-gateway-rpc.mjs';
const now=2000000000,secret='whsec_OfflineFixtureSecretNoRealCredential';
const order='12345678-1234-4123-8123-123456789abc';
const session={id:'cs_live_Fixture',mode:'payment',livemode:true,status:'complete',payment_status:'paid',customer:'cus_Fixture',currency:'usd',
  amount_subtotal:2500,amount_total:2800,total_details:{amount_tax:300,amount_discount:0},payment_intent:'pi_Fixture',client_reference_id:order,
  metadata:{order_id:order,funding_mode:'one_time'}};
const intent={id:'pi_Fixture',status:'succeeded',livemode:true,customer:'cus_Fixture',currency:'usd',amount_received:2800,metadata:{order_id:order,funding_mode:'one_time'}};
function envelope(extra={},pretty=false){
  const event={id:'evt_Fixture',type:'checkout.session.completed',livemode:true,created:now,data:{object:{id:session.id}},...extra};
  const raw=Buffer.from(JSON.stringify(event,null,pretty?2:undefined));
  return {raw,signature:'t='+now+',v1='+createHmac('sha256',secret).update(String(now)+'.').update(raw).digest('hex')};
}
function fixture(extra={}){
  const calls=[],seen=new Set(),facts=[];
  const objects={account:{id:STRIPE_ACCOUNTS.live},['checkout/sessions/'+session.id]:structuredClone(session),'payment_intents/pi_Fixture':structuredClone(intent),
    'refunds/re_Fixture':{id:'re_Fixture',payment_intent:'pi_Fixture',livemode:true,currency:'usd'},
    'refunds?payment_intent=pi_Fixture&limit=100':{object:'list',has_more:false,data:[{id:'re_One',payment_intent:'pi_Fixture',livemode:true,currency:'usd',status:'succeeded',amount:1400}]},
    'disputes/dp_Fixture':{id:'dp_Fixture',payment_intent:'pi_Fixture',livemode:true,currency:'usd',amount:1000,status:'needs_response'}};
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});let value;
    if(url.startsWith('https://api.stripe.com/v1/')){const key=url.slice('https://api.stripe.com/v1/'.length);assert.ok(Object.hasOwn(objects,key));value=objects[key];assert.equal(options.method,'GET');}
    else{assert.equal(url,SUPABASE_ORIGIN+'/rest/v1/rpc/'+PROJECTION_RPC);assert.equal(options.method,'POST');const p=JSON.parse(options.body);facts.push(p);
      value={applied:true,replayed:seen.has(p.p_event_id),event_id:p.p_event_id,operation:p.p_operation};seen.add(p.p_event_id);}
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  };
  const config={enabled:true,billingMode:'live',accountId:STRIPE_ACCOUNTS.live,stripeSecretKey:('sk' + '_live_' + 'OFFLINEFIXTURENOTAREALKEY'),webhookSecret:secret,
    supabaseOrigin:SUPABASE_ORIGIN,supabaseSecretKey:'sb_secret_OFFLINEFIXTURENOTAREALKEY',nowSeconds:()=>now,timeoutMs:1000,rpcTimeoutMs:500,bodyTimeoutMs:500,fetchImpl,...extra};
  return {ingress:createStripeWebhookIngress(config),config,calls,objects,facts};
}
async function server(t,ingress){
  const s=createPreparationServer(ingress===undefined?{}:{stripeWebhookIngress:ingress});
  await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);}));return s.address().port;
}
function call(port,{raw,signature}=envelope(),extra={}){
  return new Promise((resolve,reject)=>{
    // Rejection closes the connection; don't reuse a socket from a prior probe.
    const req=httpRequest({agent:false,host:'127.0.0.1',port,path:STRIPE_WEBHOOK_PATH,method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},...extra},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));res.on('error',reject);
    });req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('Offline request deadline')));req.end(['GET','HEAD'].includes(extra.method)?undefined:raw);
  });
}
await test('default preparation and explicitly disabled ingress stay503 without upstream calls',async t=>{
  const port=await server(t);assert.equal((await call(port)).status,503);
  assert.equal(preparationResponse({method:'POST',url:STRIPE_WEBHOOK_PATH}).status,503);
  let calls=0;const disabled=await server(t,createStripeWebhookIngress({fetchImpl:()=>calls++}));assert.equal((await call(disabled)).status,503);assert.equal(calls,0);
});
await test('preparation refuses arbitrary unbranded callback/config injection',()=>{
  for(const injection of [()=>{}, {handle:async()=>{}}, {},true,'enabled'])assert.throws(()=>createPreparationServer({stripeWebhookIngress:injection}),/Invalid Stripe webhook injection/);
});
await test('signed exact raw pretty bytes get canonical Stripe checks + typed fixed durable RPC before200',async t=>{
  const f=fixture(),port=await server(t,f.ingress);const raw=envelope({data:{object:{id:session.id,metadata:{user_id:'attacker',order_id:'attacker'}}}},true);
  const res=await call(port,raw);assert.equal(res.status,200);assert.deepEqual(JSON.parse(res.body),{received:true,replayed:false});
  assert.equal(f.calls.length,4);assert.equal(f.facts[0].p_fact.order_id,order);assert.equal(Object.hasOwn(f.facts[0],'p_owner'),false);
  assert.equal(res.headers['cache-control'],'no-store');assert.equal(res.headers['x-content-type-options'],'nosniff');
  assert.equal(res.body.includes(secret),false);assert.equal(res.body.includes(order),false);
});
await test('same signed event returns explicit replay only after same fixed RPC; not proof of production exactly-once',async t=>{
  const f=fixture(),port=await server(t,f.ingress);assert.equal(JSON.parse((await call(port)).body).replayed,false);
  assert.equal(JSON.parse((await call(port)).body).replayed,true);assert.equal(f.facts.length,2);
});
await test('canonical refund/dispute use exact fixed schemas, integer amounts and no event status trust',async t=>{
  const f=fixture(),port=await server(t,f.ingress);
  for(const [type,id,eventId] of [['refund.updated','re_Fixture','evt_Refund'],['charge.dispute.created','dp_Fixture','evt_Dispute']]){
    assert.equal((await call(port,envelope({type,id:eventId,data:{object:{id,status:'won',amount:1}}}))).status,200);
  }
  assert.equal(f.facts[0].p_operation,'refund');assert.equal(f.facts[0].p_fact.refunded_cents,1400);
  assert.equal(f.facts[1].p_operation,'dispute');assert.equal(f.facts[1].p_fact.status,'needs_response');assert.equal(f.facts[1].p_fact.amount_cents,1000);
});
await test('tampered/stale/invalid signatures, unsupported events and wrong modes/accounts do no HTTP',async t=>{
  const f=fixture(),port=await server(t,f.ingress),valid=envelope();
  for(const value of [{...valid,raw:Buffer.concat([valid.raw,Buffer.from(' ')])},{...valid,signature:'invalid'},
    {...valid,signature:valid.signature.replace(String(now),String(now-301))},envelope({type:'invoice.paid'}),
    envelope({livemode:false}),envelope({account:'acct_other'})])assert.notEqual((await call(port,value)).status,200);
  assert.equal(f.calls.length,0);
});
await test('method, exact path/query/encoding, content-type/encoding, duplicate signature and identity headers rejected',async t=>{
  const f=fixture(),port=await server(t,f.ingress),raw=envelope();
  for(const extra of [{method:'GET'},{method:'PUT'},{path:STRIPE_WEBHOOK_PATH+'?x=1'},{path:'/api/billing/%77ebhook'},
    {path:'/api/billing/../billing/webhook'}, {headers:{'content-type':'text/plain','stripe-signature':raw.signature}},
    {headers:{'content-type':'application/json','content-encoding':'gzip','stripe-signature':raw.signature}},
    {headers:{'content-type':'application/json','stripe-signature':[raw.signature,raw.signature]}},
    {headers:{'content-type':'application/json','stripe-signature':raw.signature,'Oai-Authenticated-User':'attacker'}}]){
    const res=await call(port,raw,extra);assert.notEqual(res.status,200);
  }assert.equal(f.calls.length,0);
});
await test('empty/oversized declared and actual/chunked body rejects before Stripe read',async t=>{
  const f=fixture(),port=await server(t,f.ingress),raw=envelope();
  for(const [value,extra] of [[{...raw,raw:Buffer.alloc(0)},{}], [{...raw,raw:Buffer.alloc(1000001)},{}],
    [raw,{headers:{'content-type':'application/json','stripe-signature':raw.signature,'content-length':'1000001'}}],
    [{...raw,raw:Buffer.alloc(1000001)},{headers:{'content-type':'application/json','stripe-signature':raw.signature,'transfer-encoding':'chunked'}}]])assert.notEqual((await call(port,value,extra)).status,200);
  assert.equal(f.calls.length,0);
});
await test('unregistered order/RPC failure or forged receipt cannot acknowledge and cannot leak upstream secrets',async t=>{
  for(const response of [new Response(JSON.stringify({message:'stripe_order_unregistered '+secret}),{status:400,headers:{'content-type':'application/json'}}),
    new Response(JSON.stringify({applied:false,replayed:false,event_id:'evt_Fixture',operation:'checkout'}),{headers:{'content-type':'application/json'}})]){
    const f=fixture();const original=f.config.fetchImpl;const ingress=createStripeWebhookIngress({...f.config,fetchImpl:(url,options)=>url.startsWith(SUPABASE_ORIGIN)?Promise.resolve(response):original(url,options)});
    const res=await call(await server(t,ingress));assert.equal(res.status,503);assert.deepEqual(JSON.parse(res.body),{received:false,error:'Webhook unavailable.'});assert.equal(res.body.includes(secret),false);
  }
});
await test('slow partial body is deadline bounded, releases admission and never reads Stripe',async t=>{
  const f=fixture({bodyTimeoutMs:20}),port=await server(t,f.ingress),raw=envelope();
  const res=await new Promise((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port,path:STRIPE_WEBHOOK_PATH,method:'POST',headers:{'content-type':'application/json','stripe-signature':raw.signature,'content-length':String(raw.raw.length)}},res=>{res.resume();res.on('end',()=>{req.destroy();resolve(res.statusCode);});});
    req.on('error',reject);req.write(raw.raw.subarray(0,2));
  });assert.equal(res,503);assert.equal(f.calls.length,0);assert.equal((await call(port)).status,200);
});
await test('bounded per-process admission returns503 for parallel excess rather than paid reads',async t=>{
  const f=fixture({maxConcurrent:1,bodyTimeoutMs:200}),port=await server(t,f.ingress),raw=envelope();
  let complete;
  const first=new Promise((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port,path:STRIPE_WEBHOOK_PATH,method:'POST',headers:{'content-type':'application/json','stripe-signature':raw.signature,'content-length':String(raw.raw.length)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.write(raw.raw.subarray(0,2));complete=()=>req.end(raw.raw.subarray(2));
  });await new Promise(r=>setTimeout(r,15));assert.equal((await call(port)).status,503);assert.equal(f.calls.length,0);complete();assert.equal(await first,200);
});
await test('aborted partial client never projects, does not crash and releases bounded admission',async t=>{
  const f=fixture({maxConcurrent:1,bodyTimeoutMs:30}),port=await server(t,f.ingress),raw=envelope();
  await new Promise((resolve,reject)=>{const socket=connect(port,'127.0.0.1',()=>{
    socket.write('POST '+STRIPE_WEBHOOK_PATH+' HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nStripe-Signature: '+raw.signature+'\r\nContent-Length: '+raw.raw.length+'\r\n\r\n{');setTimeout(()=>socket.destroy(),5);
  });socket.on('error',reject);socket.on('close',resolve);});
  await new Promise(r=>setTimeout(r,35));assert.equal(f.calls.length,0);assert.equal((await call(port)).status,200);
});
await test('bounded noncooperative canonical HTTP/RPC cannot produce2xx or automatic retries',async t=>{
  let calls=0;const f=fixture({timeoutMs:15,fetchImpl:()=>{calls++;return new Promise(()=>{});}});
  const res=await call(await server(t,f.ingress));assert.equal(res.status,503);assert.equal(calls,1);
});
await test('injecting accepted webhook leaves health readiness, checkout/inference and UI APIs closed',async t=>{
  const f=fixture(),port=await server(t,f.ingress);
  for(const [path,method] of [['/health/ready','GET'],['/api/billing/checkout','POST'],['/v1/chat/completions','POST'],['/api/customer','GET']]){
    assert.equal((await call(port,envelope(),{path,method})).status,503);
  }assert.equal(f.calls.length,0);
});
