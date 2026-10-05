// All financial/provider transports below are synthetic fixtures, never acceptance.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {createHmac} from 'node:crypto';import {createServer,request} from 'node:http';
import {sandboxConfiguration,createSandboxStripeCli,createSandboxE2eHarness,SANDBOX_OWNER,SANDBOX_ACCOUNT,SANDBOX_BUDGET} from '../runtime/sandbox-e2e-harness.mjs';
import {pinSupplierConversion} from '../runtime/subrouter-supplier-conversion.mjs';
import {runSandboxE2e,sandboxHttpHandler} from '../sandbox-e2e.mjs';
const catalog=JSON.parse(await readFile(new URL('../../../data/selected-supplier-models.json',import.meta.url),'utf8'));
const model='MiniMax-M2.7-highspeed',whsec='whsec_SyntheticListenerFixtureOnly000000';
const runId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',completionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const route={providerBudgetId:SANDBOX_BUDGET,model,upstreamModel:model,capability:'chat',maxInputTokens:512,maxInputChars:512,maxOutputTokens:128,supplierReserveCnyMicros:10000,supplierSlug:'leapnode'};
function env(){return {SUPABASE_SECRET_KEY:'sb_secret_SyntheticFixtureOnly000000',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_SyntheticFixtureOnly000000',APIWILD_SANDBOX_E2E_ENABLED:'true',APIWILD_SANDBOX_RUN_ID:runId,APIWILD_SANDBOX_PRICE_ID:'price_fixture',APIWILD_SANDBOX_ROUTE_JSON:JSON.stringify(route),APIWILD_SANDBOX_RETAIL_RATE_VERSION:'apiwild-launch-20261005',APIWILD_SANDBOX_UPSTREAM_KEY:'sk-SyntheticFixtureOnly000000',SUBROUTER_ACCOUNT_ACCESS_TOKEN:'SyntheticAccountFixtureOnly000000',SUBROUTER_ACCOUNT_USER_ID:'21872',APIWILD_SUPPLIER_CONVERSION_JSON:JSON.stringify(pinSupplierConversion({status:{quota_per_unit:500000,quota_display_type:'CNY',display_in_currency:true,price:6.8,usd_exchange_rate:6.8},observedAt:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+3600000).toISOString()}))};}
function fixture({account=SANDBOX_ACCOUNT,checkpoint=async()=>{}}={}){
 const calls=[],checkpoints=[],writes=[],seenEvents=new Set();let session,order,issued,revoked=false,refunded=false;
 const usage={currency:'USD',fundedUsdMicros:0,spentUsdMicros:0,reservedUsdMicros:0,paymentHoldUsdMicros:0,availableUsdMicros:0,completedRequests:0};
 const config=env();
 const runStripe=async args=>{
  calls.push({kind:'stripe',args});const [method,path]=args,data=Object.fromEntries(args.flatMap((v,i)=>v==='-d'?[args[i+1].split(/=(.*)/s).slice(0,2)]:[]));
  if(path==='/v1/account')return {id:account};
  if(path==='/v1/prices/price_fixture')return {id:'price_fixture',active:true,livemode:false,currency:'usd',type:'one_time',unit_amount:100};
  if(path==='/v1/checkout/sessions'&&method==='post'){
   assert.equal(data['line_items[0][quantity]'],'30');assert.equal(data['payment_intent_data[metadata][order_id]'],data['metadata[order_id]']);
   session={id:'cs_test_fixture',mode:'payment',livemode:false,customer:'cus_fixture',client_reference_id:data.client_reference_id,metadata:{order_id:data['metadata[order_id]'],funding_mode:'one_time'},currency:'usd',amount_subtotal:3000,amount_total:3000,status:'open',payment_status:'unpaid',payment_intent:null,total_details:{amount_discount:0,amount_tax:0},url:'https://checkout.stripe.com/c/fixture'};return session;
  }
  if(path==='/v1/checkout/sessions/cs_test_fixture')return session;
  if(path==='/v1/payment_intents/pi_fixture')return {id:'pi_fixture',status:'succeeded',currency:'usd',livemode:false,customer:'cus_fixture',amount_received:3000,metadata:{order_id:order.id,funding_mode:'one_time'}};
  if(path==='/v1/refunds'&&method==='post'){assert.equal(revoked,true);refunded=true;return {id:'re_fixture',payment_intent:'pi_fixture'};}
  if(path==='/v1/refunds/re_fixture')return {id:'re_fixture',payment_intent:'pi_fixture',currency:'usd'};
  if(path==='/v1/refunds'&&method==='get')return {object:'list',has_more:false,data:[{id:'re_fixture',payment_intent:'pi_fixture',currency:'usd',amount:3000,status:'succeeded'}]};
  assert.fail('Unexpected fixture CLI path '+path);
 };
 const fetchImpl=async(url,init)=>{
  assert.ok(url.startsWith('https://yautmilnpllojugpmfgy.supabase.co/rest/v1/rpc/'),'CLI marker must never reach HTTP');
  const name=url.split('/').at(-1),p=JSON.parse(init.body);calls.push({kind:'rpc',name,p});assert.equal(init.headers.apikey,config.SUPABASE_SECRET_KEY);
  if(p.p_owner!==undefined)assert.equal(p.p_owner,SANDBOX_OWNER);
  if(name==='apiwild_gateway_account_initialize')return Response.json({initialized:true,customer_id:SANDBOX_OWNER.split(':')[2],billing_mode:'test'});
  if(name==='apiwild_gateway_usage')return Response.json(usage);
  if(name==='apiwild_stripe_customer')return Response.json({customerId:'cus_fixture'});
  if(name==='apiwild_stripe_register_checkout'){assert.equal(p.p_billing_mode,'test');assert.equal(p.p_user_id,SANDBOX_OWNER);assert.equal(p.p_amount_cents,3000);order={id:p.p_order_id,session_id:p.p_session_id,status:'checkout'};return Response.json({registered:true,order_id:order.id,session_id:order.session_id});}
  if(name==='apiwild_billing_read')return Response.json({orders:order?[order]:[],suspended:false,balanceCents:3000});
  if(name==='apiwild_gateway_key_issue'){assert.deepEqual(p.p_scopes,['chat']);assert.equal(p.p_total_limit,1000000);issued=p;return Response.json({id:p.p_id,billing_mode:'test',customer_id:SANDBOX_OWNER.split(':')[2]});}
  if(name==='apiwild_gateway_key_revoke'){assert.equal(p.p_id,issued.p_id);revoked=true;return Response.json({id:p.p_id,revoked_at:new Date().toISOString()});}
  if(name==='apiwild_stripe_project'){
   const replayed=seenEvents.has(p.p_event_id);seenEvents.add(p.p_event_id);assert.equal(p.p_billing_mode,'test');assert.equal(p.p_account_id,SANDBOX_ACCOUNT);assert.equal(p.p_fact.order_id,order.id);
   if(!replayed&&p.p_operation==='checkout'){usage.fundedUsdMicros+=30000000;order.status='paid';}
   if(!replayed&&p.p_operation==='refund'){assert.equal(refunded,true);usage.fundedUsdMicros-=30000000;order.status='refunded';}
   return Response.json({applied:true,replayed,event_id:p.p_event_id,operation:p.p_operation});
  }
  assert.fail('Unexpected fixture RPC '+name);
 };
 const harness=createSandboxE2eHarness({env:config,catalog,runStripe,fetchImpl,checkpoint:async value=>{checkpoints.push(value);await checkpoint(value);},write:value=>writes.push(value)});
 harness.setWebhookSecret(whsec);
 const signed=async(type='checkout.session.completed',eventId='evt_paid')=>{
  if(type==='checkout.session.completed'){session.status='complete';session.payment_status='paid';session.payment_intent='pi_fixture';}
  const t=Math.floor(Date.now()/1000),body=Buffer.from(JSON.stringify({id:eventId,type,created:t,livemode:false,data:{object:{id:type.startsWith('checkout')?'cs_test_fixture':'re_fixture'}}}));
  const signature='t='+t+',v1='+createHmac('sha256',whsec).update(t+'.').update(body).digest('hex');return harness.webhook(body,signature);
 };
 const gateway=async({authorization,requestKey,body})=>{
  assert.match(authorization,/^Bearer aw_test_[a-f0-9]{64}$/);assert.equal(requestKey,'sandbox_'+runId.replaceAll('-',''));assert.equal(body.max_tokens,128);assert.equal(body.model,model);assert.equal(issued.p_hash.length,64);
  if(usage.completedRequests===0){usage.completedRequests++;usage.spentUsdMicros=155;}
  return {status:200,body:{id:completionId,object:'chat.completion',model,choices:[{message:{role:'assistant',content:'OK'}}],usage:{prompt_tokens:5,completion_tokens:128,total_tokens:133}}};
 };
 return {harness,calls,checkpoints,writes,signed,gateway,usage,config};
}
test('configuration is fixed to test owner/model/budget and bounded request; check performs no network',async()=>{
 const config=env();assert.equal(sandboxConfiguration(config).configured,true);assert.equal(sandboxConfiguration({}).configured,false);
 for(const patch of [{providerBudgetId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},{maxOutputTokens:129},{upstreamModel:'other'},{supplierSlug:'other'},{supportsTools:true},{supplierReserveCnyMicros:10001}])assert.throws(()=>sandboxConfiguration({...config,APIWILD_SANDBOX_ROUTE_JSON:JSON.stringify({...route,...patch})}));
 const output=[];assert.equal(await runSandboxE2e({argv:['--check'],env:config,write:x=>output.push(x)}),0);assert.equal(output[0].networkRequests,false);assert.ok(!JSON.stringify(output).includes(config.SUPABASE_SECRET_KEY));
 assert.equal(await runSandboxE2e({argv:['--serve'],env:{...config,APIWILD_SANDBOX_E2E_ENABLED:'false'},write:x=>output.push(x)}),3);
});
test('CLI transport is sandbox-default with explicit idempotency and finite operation allowlist',async()=>{
 const calls=[],cli=createSandboxStripeCli(async args=>{calls.push(args);return {id:'fixture'};});
 await cli.request('post','/v1/refunds',{payment_intent:'pi_fixture'},'fixture_unique_operation');assert.ok(calls[0].includes('--confirm'));assert.ok(calls[0].includes('--idempotency'));assert.ok(!calls[0].includes('--live'));assert.ok(!calls[0].includes('--api-key'));
 for(const path of ['/v1/balance','/v1/payment_intents/pi_fixture/confirm','https://evil.invalid/v1/refunds'])await assert.rejects(cli.request('post',path,{},'fixture_unique_operation'));
 await assert.rejects(cli.request('post','/v1/refunds',{}));assert.equal(calls.length,1);
});
test('wrong account and checkpoint failure stop before account or payment writes',async()=>{
 const wrong=fixture({account:'acct_other'});await assert.rejects(wrong.harness.createCheckout());assert.equal(wrong.calls.length,1);assert.equal(wrong.calls[0].kind,'stripe');await assert.rejects(wrong.harness.createCheckout());assert.equal(wrong.calls.length,1);
 const failed=fixture({checkpoint:async()=>{throw Error('fixture disk unavailable');}});await assert.rejects(failed.harness.createCheckout());assert.equal(failed.calls.length,0);
});
test('unpaid checkout never issues key or invokes gateway; phase cannot repeat',async()=>{
 const f=fixture();const created=await f.harness.createCheckout();assert.equal(created.creditsGranted,false);assert.equal((await f.harness.paymentStatus()).paid,false);
 await assert.rejects(f.harness.runModel(()=>assert.fail('No unpaid inference')));await assert.rejects(f.harness.runModel(()=>assert.fail('No repeat')));assert.ok(!f.calls.some(c=>c.name==='apiwild_gateway_key_issue'));
});
test('genuine signature logic plus canonical CLI reads gate fixture credit; replay/refund preserve one debit',async()=>{
 const f=fixture();await f.harness.createCheckout();const before=f.calls.length;await assert.rejects(f.harness.webhook(Buffer.from('{}'),'bad'));assert.equal(f.calls.length,before);
 assert.equal((await f.signed()).replayed,false);assert.equal((await f.signed()).replayed,true);assert.equal((await f.harness.paymentStatus()).paid,true);assert.equal(f.usage.fundedUsdMicros,30000000);
 const result=await f.harness.runModel(f.gateway);assert.equal(result.responseReceived,true);assert.equal(result.retailDebitUsdMicros,155);assert.equal(f.harness.requestId(),completionId);await assert.rejects(f.harness.runModel(f.gateway));
 assert.equal((await f.harness.replay(f.gateway)).unchangedUsage,true);assert.equal(f.usage.completedRequests,1);
 await f.harness.reconcile({reconcile:async input=>{assert.deepEqual(input,{owner:SANDBOX_OWNER,requestId:completionId});return {reconciled:true,held:false};}});
 assert.equal((await f.harness.refund()).creditReversalRequiresSignedEvent,true);assert.equal(f.usage.fundedUsdMicros,30000000);
 await f.signed('refund.created','evt_refund');assert.equal((await f.harness.refundStatus()).fundedReturnedToBaseline,true);assert.equal((await f.harness.close()).testKeyRevoked,true);
 assert.ok(!JSON.stringify([...f.checkpoints,...f.writes]).includes('aw_test_'));assert.ok(!JSON.stringify([...f.checkpoints,...f.writes]).includes(whsec));
});
test('empty settled content retains request for reconciliation without claiming response acceptance',async()=>{
 const f=fixture();await f.harness.createCheckout();await f.signed();const result=await f.harness.runModel(async work=>{const r=await f.gateway(work);r.body.choices[0].message.content='';return r;});assert.equal(result.responseReceived,false);assert.equal(f.harness.requestId(),completionId);await assert.rejects(f.harness.runModel(f.gateway));await f.harness.close();
});
test('private loopback transport rejects unrelated local requests before gateway, and JSON output is bounded',async()=>{
 let calls=0;const nonce='a'.repeat(64),server=createServer(sandboxHttpHandler({gateway:{handle:async(req,res)=>{calls++;res.writeHead(200);res.end('{}');}},checkoutUrl:()=>undefined,webhook:async()=>{throw Error('No valid fixture signature');}},nonce));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const send=headers=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{}');});
 try{assert.equal(await send({}),403);assert.equal(calls,0);assert.equal(await send({'x-apiwild-sandbox-transport':nonce}),200);assert.equal(calls,1);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
