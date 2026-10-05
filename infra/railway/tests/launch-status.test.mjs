import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {createLaunchStatusHttp} from '../runtime/launch-status.mjs';
import {createPreparationServer} from '../preparation-server.mjs';

const catalog=JSON.parse(await readFile(new URL('../../../data/selected-supplier-models.json',import.meta.url),'utf8'));
async function fixture(fn, options={}) {
  const server=createPreparationServer({launchStatusHttp:createLaunchStatusHttp({catalog,...options})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const call=(path,patch={})=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path,...patch},res=>{
      let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data?JSON.parse(data):null}));
    });req.on('error',reject);req.end();
  });
  try{await fn(call);}finally{await new Promise(resolve=>server.close(resolve));}
}
test('public catalogue publishes retail metadata without exposing private supplier records',async()=>{
  await fixture(async call=>{
    const response=await call('/api/models');assert.equal(response.status,200);assert.equal(response.body.models.length,39);
    assert.equal(response.body.inferenceAvailable,false);
    assert.deepEqual(response.body.models.map(m=>m.model_name),catalog.models.map(m=>m.model_name));
    const deepseek=response.body.models.find(m=>m.model_name==='deepseek-v4-flash').apiwild_selling_price;
    assert.ok(deepseek.peak.input>deepseek.input);assert.equal(typeof deepseek.tier_schedule,'string');assert.equal(deepseek.runtime_tier_selection_active,false);
    const serialized=JSON.stringify(response.body);
    for(const field of ['supplier','offer_id','potential_savings','CNY','fx','primary','backup'])assert.ok(!serialized.includes(field),field);
    assert.equal(response.headers['cache-control'],'no-store');
  });
});
test('configured services and enable flags cannot fabricate customer acceptance',async()=>{
  await fixture(async call=>{
    const live=await call('/health/live');assert.equal(live.status,200);assert.equal(live.body.alive,true);assert.equal(live.body.ready,false);
    const ready=await call('/health/ready');assert.equal(ready.status,503);assert.equal(ready.body.ready,false);assert.equal(ready.body.checks.acceptance,'not-recorded');
    assert.ok(ready.body.blockers.includes('supplier-debit-acceptance'));
    assert.ok(!ready.body.blockers.includes('inference-disabled'));
    assert.equal(ready.body.checks.sourceCommit,'a'.repeat(40));
  },{accountConfigured:true,billingConfigured:true,inferenceConfigured:true,checkoutEnabled:true,sourceCommit:'a'.repeat(40)});
});
test('status reports disabled configuration, rejects writes and forged identity, and preserves exact path routing',async()=>{
  await fixture(async call=>{
    const ready=await call('/health/ready');assert.ok(ready.body.blockers.includes('inference-disabled'));assert.ok(ready.body.blockers.includes('checkout-disabled'));
    assert.equal((await call('/api/models',{method:'POST'})).status,405);
    assert.equal((await call('/api/models',{headers:{'oai-authenticated-user-id':'forged'}})).status,403);
    assert.equal((await call('/api/models?customer=other')).status,503);
    const head=await call('/api/models',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body,null);
  });
  assert.throws(()=>createPreparationServer({launchStatusHttp:{matches:()=>true,handle(){}}}));
});
