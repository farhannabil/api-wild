// Synthetic evidence fixtures only. No release acceptance artifacts are produced.
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createServer,request} from 'node:http';
import {acceptanceGates,verifyReleaseAcceptance,loadReleaseAcceptance,releaseAcceptanceState} from '../runtime/release-acceptance.mjs';
import {createLaunchStatusHttp} from '../runtime/launch-status.mjs';import {conversion} from './supplier-receipt-fixture.mjs';
import {assertLiveness} from '../../../scripts/owned-health-contract.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),bytes=value=>Buffer.from(JSON.stringify(value));
const now=Date.parse('2026-10-05T12:00:00Z'),version='fixture-release-v1',model='MiniMax-M2.7-highspeed';
const required=[['productionLogin','ownedDashboard','ownerIsolation'],['sandboxPayment','signedWebhookCredit','retailDebit','idempotentReplay','refundReversal','testKeyRevoked','liveConfiguration'],['restrictedProductKey','finiteSharedBudget','modelProviderBindings','noAutomaticTopup','approvedExpiry'],['customerRequestMatched','actualWalletDebit','normalizedCostAudited','holdReconciled','backgroundReconciliation']];
function fixture(){
 const checkpointBytes=Object.fromEntries(acceptanceGates.map((gate,i)=>[gate,bytes({schemaVersion:1,gate,status:'passed',ownerApproved:true,observedAt:'2026-10-05T11:00:00Z',scope:i===1?'sandbox-lifecycle-and-live-configuration':i===3?'genuine-customer-sandbox-request':'production-configuration',checks:Object.fromEntries(required[i].map(k=>[k,true])),referenceDigests:[hash('synthetic fixture only '+gate)]})]));
 const manifest={schemaVersion:1,status:'accepted',version,issuedAt:'2026-10-05T11:30:00Z',validUntil:'2026-10-06T11:30:00Z',acceptedModels:[model],conversionSha256:conversion.settingsSha256,checkpoints:Object.fromEntries(acceptanceGates.map(g=>[g,hash(checkpointBytes[g])]))};
 return {manifest,checkpointBytes,version,configuredModels:[model],conversion,now};
}
const verify=f=>verifyReleaseAcceptance({...f,manifestBytes:bytes(f.manifest)});
const state=f=>({version,configuredModels:[model],availableModels:[model],conversion,billingMode:'live',checkoutBillingMode:'live',sweepEnabled:true,now,...f});
test('four exact checkpoint files produce a branded summary without private evidence',()=>{
 const f=fixture(),record=verify(f);assert.ok(record);assert.deepEqual(releaseAcceptanceState(record,state()),{recorded:true,modelCount:1,validUntil:f.manifest.validUntil});
 assert.equal(releaseAcceptanceState({...record},state()),null);assert.equal(JSON.stringify(record).includes('referenceDigests'),false);assert.equal(JSON.stringify(record).includes('checkpoint'),false);
});
test('flags, absent or altered files, malformed facts and model/version mismatch never record acceptance',()=>{
 const f=fixture();for(const patch of [{manifest:{schemaVersion:1,status:'unaccepted'}},{checkpointBytes:{}},{version:'different'},{configuredModels:['other']},{configuredModels:[model,model]},
  {manifest:{...f.manifest,acceptedModels:[model,'other']}},{manifest:{...f.manifest,checkpoints:{}}},{manifest:{...f.manifest,extra:true}},{manifest:{...f.manifest,conversionSha256:hash('different')}}])assert.equal(verify({...f,...patch}),null);
 for(const patch of [{ownerApproved:false},{status:'proposed'},{gate:'other'},{scope:'synthetic-fixture'},{checks:{}},{referenceDigests:[]},{referenceDigests:['a'.repeat(64)]},{observedAt:'2026-09-01T00:00:00Z'}]){
  const gate=acceptanceGates[0],changed=bytes({...JSON.parse(f.checkpointBytes[gate]),...patch});assert.equal(verify({...f,checkpointBytes:{...f.checkpointBytes,[gate]:changed},manifest:{...f.manifest,checkpoints:{...f.manifest.checkpoints,[gate]:hash(changed)}}}),null);
 }
 assert.equal(verify({...f,checkpointBytes:{...f.checkpointBytes,[acceptanceGates[0]]:Buffer.from('{}')}}),null);
});
test('time bounds, conversion expiry, test billing, disabled worker and missing available route fail closed',()=>{
 const f=fixture(),record=verify(f);
 for(const patch of [{now:Date.parse(f.manifest.validUntil)},{now:Date.parse(f.manifest.issuedAt)-1},{now:NaN},{billingMode:'test'},{checkoutBillingMode:'test'},{checkoutBillingMode:undefined},{sweepEnabled:false},{availableModels:[]},{availableModels:['other']},{configuredModels:['other']},{conversion:{...conversion,validUntil:'2026-10-05T12:00:00Z'}},{conversion:{...conversion,settingsSha256:hash('drift')}}])assert.equal(releaseAcceptanceState(record,state(patch)),null);
 assert.equal(verify({...f,now:Date.parse(f.manifest.validUntil)}),null);assert.equal(verify({...f,manifest:{...f.manifest,validUntil:'2026-11-05T00:00:00Z'}}),null);
});
test('live inference cannot report launch ready when checkout credits a test wallet',()=>{
 const f=fixture(),record=verify(f);
 for(const checkoutBillingMode of ['test',undefined]){
  const status=createLaunchStatusHttp({sourceCommit:'f'.repeat(40),accountConfigured:true,billingConfigured:true,inferenceConfigured:true,checkoutEnabled:true,
   acceptance:record,...state({checkoutBillingMode}),availableModels:()=>[model],clock:()=>now});
  for(const url of ['/health/ready','/health/live']){
   let code,body;status.handle({url,method:'GET',headers:{},resume(){}},{writeHead(value){code=value;},end(value){body=JSON.parse(value);}});
   assert.equal(code,url==='/health/ready'?503:200);assert.equal(body.ready,false);assert.equal(body.phase,'launch-preparation');
   if(url==='/health/ready')assert.ok(body.blockers.includes('payment-lifecycle-acceptance'));else assertLiveness(body);
  }
 }
});
test('fixed file loader rejects missing/unaccepted/mismatched files and never uses manifest paths',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'apiwild-release-test-'));
 t.after(async()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'apiwild-release-test-'));await fs.rm(directory,{recursive:true,force:true});});
 const f=fixture();assert.equal(await loadReleaseAcceptance({...f,directory}),null);
 await fs.writeFile(path.join(directory,'release-acceptance.json'),bytes({schemaVersion:1,status:'unaccepted'}));assert.equal(await loadReleaseAcceptance({...f,directory}),null);
 await fs.writeFile(path.join(directory,'release-acceptance.json'),bytes(f.manifest));for(const gate of acceptanceGates)await fs.writeFile(path.join(directory,gate+'.json'),f.checkpointBytes[gate]);
 assert.ok(await loadReleaseAcceptance({...f,directory}));await fs.writeFile(path.join(directory,acceptanceGates[0]+'.json'),'{}');assert.equal(await loadReleaseAcceptance({...f,directory}),null);
});
test('accepted health is coherent and loses readiness immediately on expiry or route loss without leaking evidence',async()=>{
 const f=fixture();let current=now,available=[model];const status=createLaunchStatusHttp({sourceCommit:'f'.repeat(40),accountConfigured:true,billingConfigured:true,inferenceConfigured:true,checkoutEnabled:true,
  acceptance:verify(f),...state(),availableModels:()=>available,clock:()=>current});
 const server=createServer((req,res)=>status.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=route=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:route},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,raw,body:JSON.parse(raw)}));});req.on('error',reject);req.end();});
 try{
  let result=await call('/health/ready');assert.equal(result.status,200);assert.equal(result.body.ready,true);assert.deepEqual(result.body.blockers,[]);assert.equal(result.body.checks.acceptedModelCount,1);
  for(const secret of [model,conversion.settingsSha256,'referenceDigests','ownerApproved','sandbox','quota'])assert.equal(result.raw.includes(secret),false);
  const live=await call('/health/live');assertLiveness(live.body);assert.equal(live.body.ready,true);
  available=[];assert.equal((await call('/health/ready')).status,503);available=[model];current=Date.parse(f.manifest.validUntil);result=await call('/health/ready');assert.equal(result.status,503);assert.equal(result.body.checks.acceptance,'not-recorded');assertLiveness((await call('/health/live')).body);
 }finally{await new Promise(r=>server.close(r));}
 for(const value of [{alive:true,ready:true,phase:'launch-preparation'},{alive:true,ready:false,phase:'launched'},{alive:true,ready:'true',phase:'launched'}])assert.throws(()=>assertLiveness(value));
});
test('release artifact is private and an unaccepted manifest cannot be enabled by configuration',async()=>{
 const file=new URL('../release/release-acceptance.json',import.meta.url);assert.ok(['unaccepted','accepted'].includes(JSON.parse(await fs.readFile(file,'utf8')).status));
 const f=fixture();assert.equal(verify({...f,manifest:{schemaVersion:1,status:'unaccepted'}}),null);
 const ignore=await fs.readFile(new URL('../../../Dockerfile.railway.dockerignore',import.meta.url),'utf8'),docker=await fs.readFile(new URL('../../../Dockerfile.railway',import.meta.url),'utf8');
 assert.ok(ignore.includes('!infra/railway/release/release-acceptance.json'));assert.ok(docker.includes('COPY --from=build /app/infra/railway/release ./infra/railway/release'));assert.equal(ignore.includes('!infra/railway/release/**'),false);
});
