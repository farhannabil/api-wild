import test from 'node:test';
import assert from 'node:assert/strict';
import {creditMessage,createCreditEmailWorker} from '../runtime/credit-email-worker.mjs';
const id='11111111-1111-4111-8111-111111111111';
const lease='22222222-2222-4222-8222-222222222222';
const provider='33333333-3333-4333-8333-333333333333';
const job={id,leaseId:lease,recipient:'customer@example.test',amountCents:9000,source:'card'};
test('credit mail formats exact credited amount and contains no customer-controlled HTML',()=>{
 const m=creditMessage(job);assert.match(m.text,/\$90\.00 USD/);assert.equal(m.to[0],job.recipient);assert.match(m.html,/https:\/\/apiwild\.com\/console\/billing/);
 assert.match(creditMessage({...job,source:'promo'}).text,/from your promo code/);
 for(const change of [{amountCents:0},{amountCents:0.5},{source:'refund'},{recipient:'x@example.test\r\nBcc:evil@example.test'},{leaseId:'bad'}])assert.throws(()=>creditMessage({...job,...change}));
});
test('ambiguous provider retry keeps identical provider idempotency key and body across new leases',async()=>{
 const sends=[],finishes=[];let claims=0;
 const worker=createCreditEmailWorker({enabled:true,apiKey:'dummy',rpc:async(name,args)=>{
  if(name==='apiwild_claim_credit_email')return {...job,leaseId:claims++===0?lease:provider};
  finishes.push(args);return {finished:true};
 },fetchImpl:async(url,opts)=>{sends.push({url,key:opts.headers['Idempotency-Key'],body:opts.body});if(sends.length===1)throw Error('response lost');return Response.json({id:provider});}});
 await worker.tick();await worker.tick();assert.deepEqual(sends[0],sends[1]);assert.equal(sends[0].key,'credit-email/'+id);
 assert.equal(finishes[0].p_outcome,'retry');assert.equal(finishes[0].p_lease,lease);assert.equal(finishes[1].p_outcome,'sent');assert.equal(finishes[1].p_lease,provider);assert.equal(finishes[1].p_provider,provider);
});
test('provider rejection, rate limits, malformed receipts and lease loss are not accepted as sent',async()=>{
 for(const [response,outcome] of [[new Response('',{status:429}),'retry'],[new Response('',{status:503}),'retry'],[new Response('',{status:422}),'failed'],[Response.json({id:'not-an-id'}),'retry']]){
  let finish;const messages=[];
  const worker=createCreditEmailWorker({enabled:true,apiKey:'dummy',fetchImpl:async()=>response,rpc:async(name,args)=>{if(name==='apiwild_claim_credit_email')return job;finish=args;return {finished:false};},write:x=>messages.push(x)});
  await worker.tick();assert.equal(finish.p_outcome,outcome);assert.equal(finish.p_provider,null);assert.deepEqual(messages,[{creditEmail:'lease-unconfirmed'}]);
 }
});
test('parallel ticks cannot claim a second job while first send is active',async()=>{
 let claims=0,resolve;const wait=new Promise(r=>resolve=r);
 const worker=createCreditEmailWorker({enabled:true,apiKey:'dummy',rpc:async name=>{if(name==='apiwild_claim_credit_email'){claims++;return job;}return {finished:true};},fetchImpl:async()=>{await wait;return Response.json({id:provider});}});
 const first=worker.tick();await worker.tick();assert.equal(claims,1);resolve();await first;worker.stop();await worker.tick();assert.equal(claims,1);
});
test('disabled or unconfigured mail worker never claims jobs',async()=>{
 for(const opts of [{enabled:false,apiKey:'dummy'},{enabled:true,apiKey:''}]){const worker=createCreditEmailWorker({...opts,rpc:()=>assert.fail('unexpected claim')});await worker.tick();worker.start();worker.stop();}
});
