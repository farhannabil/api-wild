import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
function load(file){
 const module={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,Error,Date,Set,require:n=>n.startsWith('@/')?(n.endsWith('.mjs')?require('../'+n.slice(2)):load(n.slice(2)+'.ts')):require(n)});
 return module.exports;
}
const {customerProfileData,saveCustomerProfile,watchCustomerIdentity,CustomerAccountChangedError}=load('lib/customer-profile.ts');
const {buildingOptions,complianceOptions}=load('lib/customer-options.ts');
const valid={name:'Sample',company:'Project',budget:100,accountType:'personal',domain:'example.com',phone:'+12045550123',country:'CA',building:[buildingOptions[0]],compliance:[],project:''};
test('stored malformed preferences recover independently without losing valid profile fields',()=>{
 const data=customerProfileData({full_name:' Sample ',company_name:' Project ',role:'personal',onboarding_data:{...valid,compliance:null,building:[null,'unknown',buildingOptions[0],buildingOptions[0]],budget:{toString:null},domain:{},country:'XX'}});
 assert.equal(data.name,'Sample');assert.equal(data.company,'Project');assert.equal(data.accountType,'personal');
 assert.equal(data.budget,100);assert.equal(data.domain,'');assert.equal(data.country,'');
 assert.deepEqual(Array.from(data.building),[buildingOptions[0]]);assert.deepEqual(Array.from(data.compliance),[]);
 assert.equal(data.compliance.includes(complianceOptions[0]),false);
 for(const extra of [null,[],123,'invalid'])assert.doesNotThrow(()=>customerProfileData({onboarding_data:extra}));
});
test('valid preferences survive normalization and legacy use_case remains recoverable',()=>{
 const data=customerProfileData({onboarding_data:valid});
 assert.deepEqual(JSON.parse(JSON.stringify(data)),valid);
 assert.deepEqual(Array.from(customerProfileData({use_case:buildingOptions[1]}).building),[buildingOptions[1]]);
});
function clientFor(user){
 const calls=[];
 return {
  calls,
  auth:{getUser:async()=>({data:{user},error:null})},
  from(table){return {
   upsert(payload,options){
    calls.push({table,payload,options});
    return {select(){return {single:async()=>({data:{user_id:payload.user_id},error:null})};}};
   }
  };}
 };
}
test('an account switch or ended session cannot save another account’s cached form',async()=>{
 for(const user of [{id:'account-b'},null]){
  const client=clientFor(user);
  await assert.rejects(saveCustomerProfile(client,'account-a',valid),CustomerAccountChangedError);
  assert.equal(client.calls.length,0);
 }
});
test('profile writes use the loaded owner and validated values, never a submitted user id',async()=>{
 const client=clientFor({id:'account-a'});
 await saveCustomerProfile(client,'account-a',{...valid,name:' Sample ',user_id:'account-b'});
 assert.equal(client.calls.length,1);assert.equal(client.calls[0].payload.user_id,'account-a');
 assert.equal(client.calls[0].payload.full_name,'Sample');assert.equal(client.calls[0].payload.onboarding_data.user_id,undefined);
});
test('identity watcher ignores token refresh and invalidates once for another account or signout',()=>{
 for(const next of ['account-b',null]){
  let emit,unsubscribed=0;const changes=[];
  const client={auth:{onAuthStateChange(callback){emit=callback;return {data:{subscription:{unsubscribe(){unsubscribed++;}}}};}}};
  const stop=watchCustomerIdentity(client,'account-a',id=>changes.push(id));
  emit('INITIAL_SESSION',{user:{id:'account-a'}});emit('TOKEN_REFRESHED',{user:{id:'account-a'}});
  assert.equal(changes.length,0);
  emit(next?'SIGNED_IN':'SIGNED_OUT',next?{user:{id:next}}:null);
  emit('SIGNED_OUT',null);assert.deepEqual(changes,[next]);
  stop();assert.equal(unsubscribed,1);emit('SIGNED_IN',{user:{id:'account-c'}});assert.deepEqual(changes,[next]);
 }
});

test('profile requires a country and international phone number',()=>{const {onboardingSchema}=load('lib/onboarding-schema.ts');assert.equal(onboardingSchema.safeParse({...valid,phone:''}).success,false);assert.equal(onboardingSchema.safeParse({...valid,country:''}).success,false);assert.equal(onboardingSchema.parse({...valid,phone:'+1 (204) 555-0123'}).phone,'+12045550123');});
