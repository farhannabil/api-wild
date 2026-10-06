import test from 'node:test';import assert from 'node:assert/strict';
import {repairPath,treeDigest,observation,agentAvailable,validReceipt,parseAttestation,COMPANY} from '../scripts/maintenance/policy.mjs';
const commit='a'.repeat(40),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('source fixes are allowed without opening authority, secrets, dependencies or migrations',()=>{
 for(const path of ['app/login/page.tsx','lib/customer-api.ts','infra/railway/runtime/stripe-checkout.mjs','tests/keys.test.mjs','data/model-pricing.json','scripts/daily-health.mjs'])assert.equal(repairPath(path,id),true,path);
 for(const path of ['.github/workflows/apiwild.yml','.env','app/.env.local','lib/../../secrets/key.json','app\\page.tsx','/app/page.tsx','package.json','package-lock.json','supabase/migrations/fix.sql','scripts/maintenance/controller.mjs','.git/config','app/secret.key'])assert.equal(repairPath(path,id),false,path);
 assert.equal(repairPath(`.claude/it-team-evidence/${id}.json`,id),true);assert.equal(repairPath('.claude/it-team-evidence/other.json',id),false);
});
test('one transient source failure does not wake an agent; two matching failures do',()=>{
 const first=observation(null,{commit,failures:['Page /login']},1000);assert.equal(first.action,'observe');
 const second=observation(first,{commit,failures:['Page /login']},301000);assert.equal(second.action,'confirmed_failure');
 assert.equal(observation(second,{commit,failures:[]},601000).action,'healthy');
 assert.equal(observation(second,{commit:'b'.repeat(40),failures:['Page /login']},601000).action,'observe');
});
test('digest binds every file content and deletion with stable ordering',()=>{
 const entries=[{path:'app/a.ts',kind:'file',bytes:Buffer.from('one')},{path:'app/b.ts',kind:'deleted'}];
 assert.equal(treeDigest(entries),treeDigest(entries.toReversed()));
 assert.notEqual(treeDigest(entries),treeDigest([{...entries[0],bytes:Buffer.from('two')},entries[1]]));
 assert.notEqual(treeDigest(entries),treeDigest(entries.slice(0,1)));
});
test('native roles must be ready with their existing model, permissions and remaining monthly budget',()=>{
 const agent={companyId:COMPANY,status:'idle',adapterType:'claude_local',adapterConfig:{dangerouslySkipPermissions:false,model:'claude-opus-5'},budgetMonthlyCents:200,spentMonthlyCents:0};
 assert.equal(agentAvailable(agent),true);
 for(const patch of [{status:'paused'},{budgetMonthlyCents:0},{spentMonthlyCents:200},{adapterType:'codex_local'},{companyId:'other'}])assert.equal(agentAvailable({...agent,...patch}),false);
 assert.equal(agentAvailable({...agent,adapterConfig:{...agent.adapterConfig,dangerouslySkipPermissions:true}}),false);
});
test('review claims require the actual unchanged tree and base commit',()=>{
 const digest='b'.repeat(64),receipt={status:'passed',summary:'Reviewed source and test evidence',baseCommit:commit,treeDigest:digest};
 assert.equal(validReceipt(receipt,commit,digest),true);
 for(const patch of [{status:'failed'},{baseCommit:'c'.repeat(40)},{treeDigest:'d'.repeat(64)},{summary:''}])assert.equal(validReceipt({...receipt,...patch},commit,digest),false);
});
test('authenticated final attestation must be pure JSON with four unique exact fields',()=>{const value={status:'passed',summary:'Reviewed actual source',baseCommit:commit,treeDigest:'b'.repeat(64)},text=JSON.stringify(value);assert.deepEqual(parseAttestation(text,commit,value.treeDigest),value);for(const invalid of ['```json\n'+text+'\n```',text.replace('{','{"status":"failed",'),text.replace('{','{"\\u0073tatus":"failed",'),JSON.stringify({...value,extra:true}),JSON.stringify({...value,status:'blocked'})])assert.throws(()=>parseAttestation(invalid,commit,value.treeDigest));});
