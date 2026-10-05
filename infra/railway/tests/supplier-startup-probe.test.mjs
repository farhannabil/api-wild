import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {createSupplierStartupProbeFromEnv} from '../runtime/supplier-startup-probe.mjs';
import {conversion,status,receiptNow} from './supplier-receipt-fixture.mjs';
const commit='a'.repeat(40),secret='aw_live_'+'b'.repeat(64);
const environment={APIWILD_SUPPLIER_STARTUP_PROBE_ENABLED:'true',APIWILD_SUPPLIER_CONVERSION_JSON:JSON.stringify(conversion),RAILWAY_GIT_COMMIT_SHA:commit,SUBROUTER_API_KEY:secret,SUPABASE_SECRET_KEY:'sb_secret_synthetic_do_not_log'};
test('disabled by default and requires exact opt-in, with no fetch or logs',async()=>{
  let calls=0;for(const flag of [undefined,'false','TRUE','1']){const output=[],probe=createSupplierStartupProbeFromEnv({env:{...environment,APIWILD_SUPPLIER_STARTUP_PROBE_ENABLED:flag},fetchImpl:async()=>{calls++;throw Error('Unexpected network');},write:r=>output.push(r)});assert.equal(probe.enabled,false);assert.deepEqual(await probe.start(),{enabled:false});assert.deepEqual(await probe.start(),{enabled:false});assert.equal(output.length,0);}assert.equal(calls,0);
});
test('one concurrent or repeated start makes one unpaid bounded status GET with no credentials',async()=>{
  const output=[];let calls=0,release;const wait=new Promise(resolve=>{release=resolve;});
  const probe=createSupplierStartupProbeFromEnv({env:environment,clock:()=>receiptNow,write:r=>output.push(r),fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://subrouter.ai/api/status');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.deepEqual(init.headers,{accept:'application/json'});assert.ok(init.signal instanceof AbortSignal);await wait;return Response.json({success:true,data:status});}});
  const first=probe.start(),second=probe.start();assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);release();const result=await first;assert.equal(await probe.start(),result);assert.deepEqual(result,{supplierStartupProbe:'PASS',sourceCommit:commit,unpaid:true});assert.deepEqual(output,[result]);assert.equal(calls,1);assert.equal(JSON.stringify(output).includes(secret),false);
});
test('remote failure is logged safely once and never rejects customer startup',async()=>{
  const output=[];let calls=0;const probe=createSupplierStartupProbeFromEnv({env:environment,clock:()=>receiptNow,write:r=>output.push(r),fetchImpl:async()=>{calls++;throw Error(secret);}});assert.equal((await probe.start()).supplierStartupProbe,'FAIL');assert.equal((await probe.start()).supplierStartupProbe,'FAIL');assert.equal(calls,1);assert.equal(output.length,1);assert.equal(JSON.stringify(output).includes(secret),false);
});
test('stalled status read aborts at five seconds without retry or startup rejection',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});const output=[];let calls=0,signal;
  const probe=createSupplierStartupProbeFromEnv({env:environment,clock:()=>receiptNow,write:r=>output.push(r),fetchImpl:async(url,init)=>{calls++;signal=init.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error(secret)),{once:true}));}});
  const pending=probe.start();await Promise.resolve();assert.equal(calls,1);context.mock.timers.tick(4999);assert.equal(signal.aborted,false);assert.equal(output.length,0);context.mock.timers.tick(1);assert.equal((await pending).supplierStartupProbe,'FAIL');assert.equal(signal.aborted,true);assert.equal(await probe.start(),await pending);assert.equal(calls,1);assert.equal(output.length,1);assert.equal(JSON.stringify(output).includes(secret),false);
});
test('conversion mismatch fails safely and raw response or invalid commit is never logged',async()=>{
  const output=[];const probe=createSupplierStartupProbeFromEnv({env:{...environment,RAILWAY_GIT_COMMIT_SHA:secret},clock:()=>receiptNow,write:r=>output.push(r),fetchImpl:async()=>Response.json({success:true,data:{...status,price:7.1,usd_exchange_rate:7.1,secret}})});assert.deepEqual(await probe.start(),{supplierStartupProbe:'FAIL',sourceCommit:null,unpaid:true});assert.equal(JSON.stringify(output).includes(secret),false);
});
test('bad or expired conversion does not fetch and broken logging never rejects start',async()=>{
  let calls=0;for(const json of ['not-json',JSON.stringify({...conversion,validUntil:'2026-10-05T00:00:00Z'})]){const probe=createSupplierStartupProbeFromEnv({env:{...environment,APIWILD_SUPPLIER_CONVERSION_JSON:json},clock:()=>receiptNow,fetchImpl:async()=>{calls++;throw Error('Unexpected fetch');},write:()=>{throw Error(secret);}});assert.equal((await probe.start()).supplierStartupProbe,'FAIL');}assert.equal(calls,0);
});
test('production hook is after listen, local preview disabled, and module ships in existing image',async()=>{
  const server=await fs.readFile(new URL('../preparation-server.mjs',import.meta.url),'utf8'),docker=await fs.readFile(new URL('../../../Dockerfile.railway',import.meta.url),'utf8'),allowlist=await fs.readFile(new URL('../../../Dockerfile.railway.dockerignore',import.meta.url),'utf8');
  assert.equal((server.match(/createSupplierStartupProbeFromEnv\(/g)||[]).length,1);assert.ok(server.indexOf('createSupplierStartupProbeFromEnv({env:listener.local?{}:process.env')>server.indexOf('frontend.listen(listener.port'));assert.match(docker,/COPY --from=build \/app\/infra\/railway\/runtime \.\/infra\/railway\/runtime/);assert.ok(allowlist.split(/\r?\n/).includes('!infra/railway/runtime/supplier-startup-probe.mjs'));
});
