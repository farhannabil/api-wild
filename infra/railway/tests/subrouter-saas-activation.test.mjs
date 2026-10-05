import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubrouterSaasActivation} from '../runtime/subrouter-saas-activation.mjs';

const fact = {userId: 123, packageId: 42, code: 'ABCD-EFGH-IJKL', orderId: 'apiwild_paid_123', expectedQuota: 5000000};
const token = 'fixture-server-only-token';
const receipt = (changes={}) => new Response(JSON.stringify({success:true,data:{user_id:123,package_id:42,
  order_id:fact.orderId,quota_redeemed:fact.expectedQuota,already_activated:false,...changes}}),
  {status:200,headers:{'content-type':'application/json'}});

test('disabled activation never calls the station', async () => {
  const activate=createSubrouterSaasActivation({fetchImpl:()=>{throw Error('unexpected fetch');}});
  await assert.rejects(activate(fact),{code:'subrouter_activation_disabled'});
});

test('exact paid-order facts and returned quota are required', async () => {
  let calls=0;
  const activate=createSubrouterSaasActivation({enabled:true,token,fetchImpl:async(url,request)=>{
    calls++;
    assert.equal(url,'https://apiwild.subrouter.ai/api/dist/internal/saas/activate');
    assert.equal(request.redirect,'error');
    assert.equal(request.headers['X-SubRouter-Saas-Activation-Token'],token);
    assert.deepEqual(JSON.parse(request.body),{user_id:123,package_id:42,code:fact.code,order_id:fact.orderId});
    return receipt();
  }});
  assert.deepEqual(await activate(fact),{orderId:fact.orderId,userId:123,packageId:42,quotaRedeemed:5000000,alreadyActivated:false});
  await assert.rejects(activate({...fact,expectedQuota:0}),{code:'subrouter_activation_invalid_fact'});
  await assert.rejects(activate({...fact,orderId:''}),{code:'subrouter_activation_invalid_fact'});
  assert.equal(calls,1);
});

test('idempotent replay is accepted, but mismatched or failed grants are quarantined', async () => {
  const make=body=>createSubrouterSaasActivation({enabled:true,token,fetchImpl:async()=>body});
  assert.equal((await make(receipt({already_activated:true}))(fact)).alreadyActivated,true);
  for(const body of [receipt({quota_redeemed:4999999}),receipt({order_id:'foreign'}),
    new Response(JSON.stringify({success:false,message:'secret'}),{status:200,headers:{'content-type':'application/json'}}),
    new Response('bad',{status:302,headers:{location:'https://elsewhere.example'}})]) {
    await assert.rejects(make(body)(fact),error=>error.code==='subrouter_activation_unverified'&&!error.message.includes('secret'));
  }
});
