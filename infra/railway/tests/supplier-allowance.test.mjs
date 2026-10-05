import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSubrouterSaasActivation} from '../runtime/subrouter-saas-activation.mjs';
import {createSupplierAllowanceWorker} from '../runtime/supplier-allowance-worker.mjs';
import {createSupplierDebitReconciler} from '../runtime/supplier-debit-reconciliation.mjs';
const owner='test:supabase:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orderId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const codeReference='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const code='TEST-REDEMPTION-CODE';
const fact={userId:123,packageId:42,code,orderId,expectedQuota:7654321};
const record={order_id:orderId,user_id:owner,state:'executing',version:1,native_user_id:123,
  package_id:42,expected_quota:7654321,code_reference:codeReference,code_sha256:createHash('sha256').update(code).digest('hex')};
const receipt={orderId,userId:123,packageId:42,quotaRedeemed:7654321,alreadyActivated:false};
const envelope=change=>new Response(JSON.stringify({success:true,data:{user_id:123,package_id:42,
  order_id:orderId,quota_redeemed:7654321,already_activated:false,...change}}),{headers:{'content-type':'application/json'}});

test('activation and worker remain off by default',async()=>{
  await assert.rejects(createSubrouterSaasActivation()(fact),{code:'subrouter_activation_disabled'});
  await assert.rejects(createSupplierAllowanceWorker().run({owner,orderId}),{code:'allowance_worker_disabled'});
  await assert.rejects(createSupplierDebitReconciler().reconcile({owner,requestId:orderId}),{code:'supplier_reconciliation_disabled'});
});
test('activation uses the documented fixed contract and verifies exact native quota',async()=>{
  let calls=0;
  const activate=createSubrouterSaasActivation({enabled:true,token:'fixture-token-12345',fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://apiwild.subrouter.ai/api/dist/internal/saas/activate');
    assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{
      user_id:123,package_id:42,code,order_id:orderId});return envelope({already_activated:true});
  }});
  assert.deepEqual(await activate(fact),{...receipt,alreadyActivated:true});assert.equal(calls,1);
  await assert.rejects(activate({...fact,expectedQuota:0}),{code:'subrouter_activation_invalid_fact'});
  await assert.rejects(activate({...fact,code:{toString(){throw Error('getter executed');}}}),{code:'subrouter_activation_invalid_fact'});
  assert.equal(calls,1);
});
test('activation rejects mismatched receipt, redirect, overlong and malformed bodies',async()=>{
  for(const response of [envelope({quota_redeemed:1}),envelope({user_id:999}),envelope({order_id:'other'}),
    new Response('sensitive upstream secret',{status:500}),new Response('x',{status:302}),
    new Response('x'.repeat(8193),{headers:{'content-type':'application/json'}})]){
    const activate=createSubrouterSaasActivation({enabled:true,token:'fixture-token-12345',fetchImpl:async()=>response});
    await assert.rejects(activate(fact),{code:'subrouter_activation_unverified'});
  }
});
test('activation deadline bounds a stalled fetch and a stalled body without retry',async()=>{
  let calls=0;
  for(const fetchImpl of [()=>{calls++;return new Promise(()=>{});},async()=>{
    calls++;return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}});
  }]){
    const start=Date.now();const activate=createSubrouterSaasActivation({enabled:true,token:'fixture-token-12345',fetchImpl,timeoutMs:20});
    await assert.rejects(activate(fact),{code:'subrouter_activation_unverified'});assert.ok(Date.now()-start<1000);
  }
  assert.equal(calls,2);
});
function worker(overrides={}){
  const calls=[];let activations=0;
  const rpc=async(name,params)=>{calls.push({name,params});if(name==='apiwild_allowance_claim')return {claimed:true,record};
    if(name==='apiwild_allowance_dispatch_guard')return {dispatch:true};if(name==='apiwild_allowance_finish')return {activated:true};return {held:true};};
  const instance=createSupplierAllowanceWorker({enabled:true,rpc,resolveCode:async()=>code,activate:async()=>{activations++;return receipt;},...overrides});
  return {instance,calls,activations:()=>activations};
}
test('worker activates exact mapped order once and sends no raw redemption code to SQL',async()=>{
  const w=worker();assert.deepEqual(await w.instance.run({owner,orderId}),{activated:true,status:'activated',automaticRetry:false});
  assert.equal(w.activations(),1);assert.deepEqual(w.calls.map(x=>x.name),['apiwild_allowance_claim','apiwild_allowance_dispatch_guard','apiwild_allowance_finish']);
  assert.equal(JSON.stringify(w.calls).includes(code),false);
});
test('lost or duplicate claim never dispatches',async()=>{
  for(const rpc of [async()=>({claimed:false,state:'executing'}),async()=>{throw Error('lost claim response');}]){
    const w=worker({rpc});assert.equal((await w.instance.run({owner,orderId})).activated,false);assert.equal(w.activations(),0);
  }
});
test('foreign owner or changed code fails before activation and leaves a hold',async()=>{
  for(const overrides of [{resolveCode:async()=>code+'-WRONG'},
    {rpc:async()=>({claimed:true,record:{...record,user_id:'test:supabase:dddddddd-dddd-4ddd-8ddd-dddddddddddd'}})}]){
    const w=worker(overrides);assert.equal((await w.instance.run({owner,orderId})).activated,false);assert.equal(w.activations(),0);
  }
});
test('refund or expired claim guard blocks native grant after secret resolution',async()=>{
  const w=worker({rpc:async name=>name==='apiwild_allowance_claim'?{claimed:true,record}:{dispatch:false}});
  assert.equal((await w.instance.run({owner,orderId})).activated,false);assert.equal(w.activations(),0);
});
test('ambiguous activation and failed finish are held without automatic native retry',async()=>{
  for(const failureAt of ['activate','finish']){
    let calls=0;const names=[];let claimable=true;
    const rpc=async name=>{names.push(name);if(name==='apiwild_allowance_claim'){
      if(!claimable)return {claimed:false};claimable=false;return {claimed:true,record};}
      if(name==='apiwild_allowance_dispatch_guard')return {dispatch:true};
      if(name==='apiwild_allowance_finish'&&failureAt==='finish')throw Error('SQL response lost');return {held:true};};
    const w=worker({rpc,activate:async()=>{calls++;if(failureAt==='activate')throw Error('network unknown');return receipt;}});
    const result=await w.instance.run({owner,orderId});assert.equal(result.automaticRetry,false);assert.equal(result.activated,false);
    assert.ok(names.includes('apiwild_allowance_uncertain'));await w.instance.run({owner,orderId});assert.equal(calls,1);
  }
});
test('a late secret callback cannot cause dispatch after the outer deadline',async()=>{
  const w=worker({timeoutMs:10,resolveCode:()=>new Promise(resolve=>setTimeout(()=>resolve(code),35))});
  assert.equal((await w.instance.run({owner,orderId})).activated,false);
  await new Promise(resolve=>setTimeout(resolve,45));assert.equal(w.activations(),0);
});
const request={owner,requestId:orderId,keyReference:codeReference,model:'model',upstreamResponseId:'chatcmpl_123',supplierPending:true};
const actual={receiptId:'native_456',keyReference:codeReference,model:'model',upstreamResponseId:'chatcmpl_123',currency:'CNY',costCnyMicros:12345,final:true};
test('supplier owner reference rejects a suffix before any trusted reader or RPC',async()=>{
  let calls=0;const unexpected=async()=>{calls++;throw Error('unexpected call');};
  const reconciler=createSupplierDebitReconciler({enabled:true,readRequest:unexpected,readReceipt:unexpected,rpc:unexpected});
  await assert.rejects(reconciler.reconcile({owner:owner+':extra',requestId:orderId}),{code:'supplier_invalid_reference'});
  assert.equal(calls,0);
});
test('actual-CNY reconciliation binds request, credential reference, model and upstream receipt',async()=>{
  let parameters;
  const reconciler=createSupplierDebitReconciler({enabled:true,readRequest:async()=>request,readReceipt:async()=>actual,
    rpc:async(name,p)=>{assert.equal(name,'apiwild_supplier_debit_apply');parameters=p;return {reconciled:true};}});
  assert.equal((await reconciler.reconcile({owner,requestId:orderId})).reconciled,true);
  assert.equal(parameters.p_fact.cost_cny_micros,12345);assert.match(parameters.p_digest,/^[a-f0-9]{64}$/);
});
test('quota-only, estimated, foreign, unfinished and fractional receipts cannot release supplier holds',async()=>{
  for(const changes of [{currency:'USD'},{currency:'QUOTA',costCnyMicros:500000},{final:false},{model:'foreign'},
    {keyReference:orderId},{upstreamResponseId:'foreign'},{costCnyMicros:0.1},{estimated:true}]){
    let calls=0;const reconciler=createSupplierDebitReconciler({enabled:true,readRequest:async()=>request,
      readReceipt:async()=>({...actual,...changes}),rpc:async()=>{calls++;return {reconciled:true};}});
    assert.equal((await reconciler.reconcile({owner,requestId:orderId})).held,true);assert.equal(calls,0);
  }
});
test('supplier overrun or an ambiguous SQL reply remains held',async()=>{
  for(const rpc of [async()=>({reconciled:false,reason:'supplier_bound_exceeded'}),async()=>{throw Error('ambiguous');}]){
    const reconciler=createSupplierDebitReconciler({enabled:true,readRequest:async()=>request,readReceipt:async()=>actual,rpc});
    assert.deepEqual(await reconciler.reconcile({owner,requestId:orderId}),{reconciled:false,held:true,automaticRetry:false});
  }
});
