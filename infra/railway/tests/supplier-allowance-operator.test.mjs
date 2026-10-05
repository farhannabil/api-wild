import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runAllowanceOperator} from '../runtime/supplier-allowance-operator.mjs';
const owner='test:supabase:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',order='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const env={SUPABASE_SECRET_KEY:'sb_secret_fixtureSecretOnly0000',SUBROUTER_SAAS_ACTIVATION_TOKEN:'fixtureActivationSecret',
  APIWILD_NATIVE_CODE_REFERENCE:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',APIWILD_NATIVE_REDEMPTION_CODE:'FIXTURE-CODE',APIWILD_ALLOWANCE_WORKER_ENABLED:'true'};
const argv=['--execute','--owner',owner,'--order',order];
const json=value=>Response.json(value);
test('operator local check and disabled mode perform no network request or secret output',async()=>{
  for(const [args,config,expected] of [[['--check',...argv.slice(1)],env,0],[argv,{...env,APIWILD_ALLOWANCE_WORKER_ENABLED:'false'},3],[argv,{},3]]){
    const out=[];const exit=await runAllowanceOperator({argv:args,env:config,fetchImpl:()=>{throw Error('unexpected network');},write:r=>out.push(r)});
    assert.equal(exit,expected);for(const value of Object.values(env).filter(v=>v!=='true'))assert.equal(JSON.stringify(out).includes(value),false);
  }
});
test('operator executes one exact accepted SQL claim with documented native activation',async()=>{
  const calls=[],out=[];
  const exit=await runAllowanceOperator({argv,env,write:r=>out.push(r),fetchImpl:async(url,request)=>{
    const name=url.split('/').pop(),p=JSON.parse(request.body);calls.push(name);
    if(name==='apiwild_allowance_claim'){assert.deepEqual(p,{p_owner:owner,p_order:order});return json({claimed:true,record:{order_id:order,user_id:owner,state:'executing',version:1,
      native_user_id:123,package_id:42,expected_quota:1234567,code_reference:env.APIWILD_NATIVE_CODE_REFERENCE,
      code_sha256:createHash('sha256').update(env.APIWILD_NATIVE_REDEMPTION_CODE).digest('hex')}});}
    if(name==='apiwild_allowance_dispatch_guard')return json({dispatch:true});
    if(name==='activate'){assert.equal(url,'https://apiwild.subrouter.ai/api/dist/internal/saas/activate');
      assert.deepEqual(p,{user_id:123,package_id:42,code:'FIXTURE-CODE',order_id:order});
      return json({success:true,data:{user_id:123,package_id:42,quota_redeemed:1234567,order_id:order,already_activated:false}});}
    if(name==='apiwild_allowance_finish')return json({activated:true});throw Error('unexpected request');
  }});
  assert.equal(exit,0);assert.deepEqual(calls,['apiwild_allowance_claim','apiwild_allowance_dispatch_guard','activate','apiwild_allowance_finish']);
  assert.deepEqual(out,[{activated:true,status:'activated',automaticRetry:false}]);
});
test('operator cannot override paid status, native identity, host or RPC through args',async()=>{
  for(const args of [[...argv,'--paid'],['--execute','--owner',owner+':other','--order',order],['--execute','--owner',owner,'--rpc','evil']]){
    assert.equal(await runAllowanceOperator({argv:args,env,fetchImpl:()=>{throw Error('unexpected network');}}),3);
  }
});
test('operator failed native activation retains the SQL claim and does not expose upstream error',async()=>{
  const out=[];let nativeCalls=0;
  const exit=await runAllowanceOperator({argv,env,write:r=>out.push(r),fetchImpl:async(url)=>{
    const name=url.split('/').pop();if(name==='apiwild_allowance_claim')return json({claimed:true,record:{order_id:order,user_id:owner,state:'executing',version:1,
      native_user_id:123,package_id:42,expected_quota:1234567,code_reference:env.APIWILD_NATIVE_CODE_REFERENCE,
      code_sha256:createHash('sha256').update(env.APIWILD_NATIVE_REDEMPTION_CODE).digest('hex')}});
    if(name==='apiwild_allowance_dispatch_guard')return json({dispatch:true});if(name==='activate'){nativeCalls++;return new Response('PRIVATE SUPPLIER ERROR',{status:502});}
    return json({held:true});
  }});
  assert.equal(exit,2);assert.equal(nativeCalls,1);assert.equal(JSON.stringify(out).includes('PRIVATE'),false);assert.equal(out[0].automaticRetry,false);
});
