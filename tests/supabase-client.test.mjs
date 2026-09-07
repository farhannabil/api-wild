import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
function load(file,overrides={}){
 const module={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module,exports:module.exports,Error,Promise,AbortSignal,fetch:overrides.fetch,require:n=>n==='@supabase/supabase-js'?overrides.sdk:n.startsWith('@/')?load(n.replace('@/','')+'.ts'):require(n)});
 return module.exports;
}
test('temporary config failure can recover without reloading the page; concurrent calls share a client',async()=>{
 let calls=0,clients=0;const sdk={createClient(){clients++;return {auth:{}}}};
 const {supabaseBrowser}=load('lib/supabase-browser.ts',{sdk,fetch:async()=>{calls++;if(calls===1)throw Error('Temporary outage');return {ok:true,json:async()=>({url:'https://fixture.supabase.co',publishableKey:'fixture-only'})}}});
 await assert.rejects(supabaseBrowser(),/Temporary outage/);
 const[a,b]=await Promise.all([supabaseBrowser(),supabaseBrowser()]);assert.equal(a,b);assert.equal(calls,2);assert.equal(clients,1);
});
test('incomplete auth configuration never creates a client and remains retryable',async()=>{
 let created=false;const{ supabaseBrowser }=load('lib/supabase-browser.ts',{sdk:{createClient(){created=true}},fetch:async()=>({ok:false,json:async()=>({error:'Not configured'})})});
 await assert.rejects(supabaseBrowser(),/Not configured/);await assert.rejects(supabaseBrowser(),/Not configured/);assert.equal(created,false);
});
test('profile validation rejects corrupt preferences before saving and normalizes names',()=>{
 const{onboardingSchema}=load('lib/onboarding-schema.ts');
 const{buildingOptions}=load('lib/customer-options.ts');
 const valid={name:' Sample ',company:' Project ',budget:100,accountType:'personal',domain:'',phone:'',country:'CA',building:[buildingOptions[0]],compliance:[],project:''};
 assert.equal(onboardingSchema.parse(valid).name,'Sample');
 for(const patch of [{name:'  '},{country:'XX'},{budget:-1},{budget:1.2},{building:[]},{building:Array(4).fill(buildingOptions[0])},{compliance:['made-up']},{project:'x'.repeat(501)}])assert.equal(onboardingSchema.safeParse({...valid,...patch}).success,false);
});
