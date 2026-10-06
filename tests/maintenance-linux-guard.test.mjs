import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {COMPANY,BACKEND,REVIEWER,HOME,CLAUDE_HOME,INCIDENTS,STATE,RUNTIME,VERIFY,NODE,GUARD,REPAIR,REVIEW,repairTools,reviewTools,identity,approval,canonical,generatedMcp,validateArgs,validateMcp,parseUnique,providerEnvironment,childEnvironment,systemdArgs,slotName,Denied} from '../scripts/maintenance/linux/policy.mjs';
import {disposition} from '../scripts/maintenance/linux/scope-hook.mjs';import {persistExclusive,admittedIntent,tokenRecord,inSlotCgroup,isBusy} from '../scripts/maintenance/linux/guardian.mjs';
const task='11111111-1111-4111-8111-111111111111',run='22222222-2222-4222-8222-222222222222',incident='33333333-3333-4333-8333-333333333333';
const root=INCIDENTS+'/'+incident,now=Date.parse('2026-10-06T06:00:00.000Z');
const native={PAPERCLIP_COMPANY_ID:COMPANY,PAPERCLIP_AGENT_ID:BACKEND,PAPERCLIP_TASK_ID:task,PAPERCLIP_RUN_ID:run};
const id=identity(native);const row={task,agent:BACKEND,cwd:root,expiry:new Date(now+60000).toISOString(),turns:8,seconds:240,profile:REPAIR,kind:'maintenance'};
const manifest=(value=row)=>Buffer.from([value.task,value.agent,value.cwd,value.expiry,value.turns,value.seconds,value.profile,value.kind].join('\t')+'\n');
const mcpValue=()=>({mcpServers:{'Paperclip projects':{type:'http',url:'http://127.0.0.1:3100/api/mcp/project-tools',headers:{Authorization:'Bearer synthetic-native-token-only'}},'Paperclip connections':{type:'http',url:'http://127.0.0.1:3100/mcp/runtime-tools',headers:{Authorization:'Bearer synthetic-native-token-only'}}}});
function fakeFs(){
 const map=new Map();const add=(name,kind='directory',content='')=>{for(let current=name;;current=path.posix.dirname(current)){if(!map.has(current))map.set(current,{kind:current===name?kind:'directory',content:current===name?content:'',nlink:1});if(current==='/')break;}return name;};
 add(root);for(const dir of ['app','lib','tests','data','public','scripts','infra/railway/runtime','.claude/it-team-evidence'])add(root+'/'+dir);
 for(const file of ['app/sample.mjs','lib/auth.mjs','scripts/daily-health.mjs','package.json'])add(root+'/'+file,'file','// fixture');
 for(const agent of [BACKEND,REVIEWER])add(generatedMcp(agent,run),'file',JSON.stringify(mcpValue()));
 const stat=name=>{const node=map.get(name);if(!node)throw Object.assign(Error('missing'),{code:'ENOENT'});return {isSymbolicLink:()=>node.kind==='link',isDirectory:()=>node.kind==='directory',isFile:()=>node.kind==='file',nlink:node.nlink};};
 return {map,add,lstatSync:stat,statSync:stat,realpathSync:name=>map.get(name)?.real??name,readFileSync:name=>map.get(name).content,readdirSync:name=>[...map.keys()].filter(file=>path.posix.dirname(file)===name&&file!==name).map(file=>path.posix.basename(file))};
}
const io=fakeFs(),a=approval(manifest(),id,root,{now,io});
const args=(profile=REPAIR,agent=BACKEND)=>['--print','--output-format','stream-json','--verbose','--model','claude-opus-5','--effort','low','--max-turns','8','--mcp-config',generatedMcp(agent,run),'--strict-mcp-config','--add-dir',root,'--setting-sources','user','--permission-mode',profile===REPAIR?'acceptEdits':'default','--allowedTools',profile===REPAIR?repairTools:reviewTools];
function denied(fn,code){assert.throws(fn,error=>error instanceof Denied&&error.code===code);}
const active={...native,FARHAN_PAPERCLIP_GUARDED_PROFILE:REPAIR,FARHAN_PAPERCLIP_GUARDED_KIND:'maintenance',FARHAN_PAPERCLIP_GUARDED_ROOT:root};
const reviewer={...active,PAPERCLIP_AGENT_ID:REVIEWER,FARHAN_PAPERCLIP_GUARDED_PROFILE:REVIEW};
const event=(tool_name,tool_input={},cwd=root)=>Buffer.from(JSON.stringify({hook_event_name:'PreToolUse',tool_name,tool_input,cwd}));
const hook=(tool,input,env=active,fixture=io)=>disposition(event(tool,input),env,fixture);
const proof=JSON.stringify({status:'passed',summary:'Synthetic check passed.',baseCommit:'a'.repeat(40),treeDigest:'b'.repeat(64)});
test('native identity is fixed company and exact lowercase UUIDs',()=>{
 assert.deepEqual(id,{task,agent:BACKEND,run});for(const change of [{PAPERCLIP_COMPANY_ID:'other'},{PAPERCLIP_TASK_ID:'invalid'},{PAPERCLIP_AGENT_ID:''},{PAPERCLIP_RUN_ID:run.toUpperCase().replace('222','ABC')}])denied(()=>identity({...native,...change}),70);
});
test('maintenance manifest admits only correct typed roles and canonical UUID child',()=>{
 assert.equal(a.profile,REPAIR);const review=approval(manifest({...row,agent:REVIEWER,profile:REVIEW}),{...id,agent:REVIEWER},root,{now,io});assert.equal(review.profile,REVIEW);
 for(const change of [{agent:REVIEWER},{profile:'inventory-v1'},{profile:'review-submit-v1'},{kind:'review'},{cwd:INCIDENTS},{turns:11},{seconds:241},{seconds:14}])denied(()=>approval(manifest({...row,...change}),id,root,{now,io}),71);
 denied(()=>approval(Buffer.from(manifest().toString().split('\t').slice(0,6).join('\t')),id,root,{now,io}),71);
 denied(()=>approval(manifest(),id,INCIDENTS,{now,io}),71);
});
test('missing/duplicate/malformed/oversized and expired approvals are refused',()=>{
 for(const bytes of [Buffer.concat([manifest(),manifest()]),Buffer.alloc(131073),Buffer.from([0xc3,0x28]),Buffer.from(''),Buffer.from(manifest().toString().replace('2026-10-06','2026-02-30'))])denied(()=>approval(bytes,id,root,{now,io}),71);
 for(const expiry of [new Date(now).toISOString(),new Date(now+86400001).toISOString()])denied(()=>approval(manifest({...row,expiry}),id,root,{now,io}),71);
});
test('Linux path checking is case sensitive and refuses symlinks, escapes and parent aliases',()=>{
 assert.equal(canonical(root,true,io),root);for(const raw of [root+'/../x',root+'/./app','C:/Windows',root.replace('/srv/','/SRV/'),'//srv/example'])denied(()=>canonical(raw,true,io),70);
 const fake=fakeFs();fake.map.get(root+'/app').kind='link';denied(()=>canonical(root+'/app/sample.mjs',false,fake),70);
 fake.map.get(root+'/app').kind='directory';fake.map.get(root+'/app/sample.mjs').real='/outside';denied(()=>canonical(root+'/app/sample.mjs',false,fake),70);
});
test('exact native args preserve role tools/model/turns and normalize one generated MCP',()=>{
 for(const [profile,agent]of [[REPAIR,BACKEND],[REVIEW,REVIEWER]]){
  const appr={...a,profile,agent};const result=validateArgs(args(profile,agent),appr,run,io);assert.equal(result[result.indexOf('--tools')+1],profile===REPAIR?'Read,Glob,Grep,Edit,Write,Bash':'Read,Glob,Grep,Write,Bash');
  assert.deepEqual(result.slice(-3),['--mcp-config',generatedMcp(agent,run),'--strict-mcp-config']);
 }
});
test('scope widening, bypass, resume, wrong model/turns and absent user setting sources fail',()=>{
 const good=args();const variants=[good.filter((_,i)=>![good.indexOf('--setting-sources'),good.indexOf('--setting-sources')+1].includes(i)),[...good,'--resume',run],[...good,'--dangerously-skip-permissions','true'],[...good,'--tools','Bash'],good.map(v=>v==='claude-opus-5'?'other-model':v),good.map(v=>v===repairTools?repairTools+',ToolSearch':v),good.map(v=>v==='acceptEdits'?'default':v),good.map(v=>v==='8'?'10':v),[...good,'--max-turns','8'],good.map(v=>v==='user'?'user,project':v)];
 for(const variant of variants)denied(()=>validateArgs(variant,a,run,io),70);
});
test('generated native MCP validates exact two endpoints/headers and rejects secret-bearing bad shapes',()=>{
 validateMcp(JSON.stringify(mcpValue()));for(const edit of [value=>value.extra=true,value=>value.mcpServers['Paperclip projects'].url='https://external.invalid',value=>value.mcpServers['Paperclip connections'].headers.extra='fixture',value=>value.mcpServers['Paperclip projects'].headers.Authorization='Basic fixture']){const value=mcpValue();edit(value);denied(()=>validateMcp(JSON.stringify(value)),70);}
 denied(()=>parseUnique('{"x":1,"\\u0078":2}'),70);denied(()=>validateMcp(JSON.stringify(mcpValue()).replace('"type":"http"','"type":"http","type":"stdio"')),70);
});
test('fixed company prompt exception is paired, hash-addressed and no arbitrary add-dir',()=>{
 const fake=fakeFs(),dir=RUNTIME+'/companies/'+COMPANY+'/claude-prompt-cache/'+'a'.repeat(64),prompt=fake.add(dir+'/agent-instructions.md','file','fixture');
 const bundled=args().map(v=>v===root?dir:v);bundled.push('--append-system-prompt-file',prompt);assert.ok(validateArgs(bundled,a,run,fake).includes(prompt));
 for(const variant of [args().map(v=>v===root?dir:v),[...args(),'--append-system-prompt-file',prompt],args().map(v=>v===root?HOME:v)])denied(()=>validateArgs(variant,a,run,fake),70);
});
test('two fixed systemd units enforce cgroup kill, no restart and exact native paths/deadline',()=>{
 for(const slot of [0,1]){const result=systemdArgs(slot,a,now);assert.ok(result.includes('--unit='+slotName(slot)));assert.ok(result.includes('--property=KillMode=control-group'));assert.ok(result.includes('--property=Restart=no'));assert.ok(result.includes('--property=RuntimeMaxSec=60000ms'));assert.deepEqual(result.slice(-4),[NODE,GUARD,'--guard-service',String(slot)]);}
 denied(()=>slotName(2),73);denied(()=>systemdArgs(0,a,a.expiry),75);
 assert.equal(inSlotCgroup('0::/user.slice/app.slice/'+slotName(0),0),true);assert.equal(inSlotCgroup('0::/wrong/'+slotName(1),0),false);assert.equal(inSlotCgroup('2:cpu:/'+slotName(0),0),false);
 assert.equal(isBusy('Failed: Unit '+slotName(0)+' already exists.',0),true);assert.equal(isBusy('arbitrary error',0),false);
});
test('intent marker is exclusive, fsynced before admission and includes no native token',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apiwild-linux-guard-'));try{
  const file=path.join(dir,'intent').replaceAll('\\','/'),parent=path.posix.dirname(file);const calls=[];
  // Windows cannot fsync a directory descriptor. The facade asserts this call;
  // the file open/exclusive/write/fsync operations are real on both platforms.
  const shim={openSync(name,flag,mode){calls.push(['open',flag,mode]);return name===parent?-1:fs.openSync(name,flag,mode);},writeFileSync:fs.writeFileSync,fsyncSync(fd){calls.push(['sync',fd===-1?'directory':'file']);if(fd!==-1)fs.fsyncSync(fd);},closeSync(fd){if(fd!==-1)fs.closeSync(fd);}};
  persistExclusive(file,admittedIntent(a,id,now),shim);assert.deepEqual(calls.filter(x=>x[0]==='sync'),[['sync','file'],['sync','directory']]);assert.equal(calls[0][2],0o600);
  denied(()=>persistExclusive(file,'second run',shim),72);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).run,run);assert.equal(fs.readFileSync(file,'utf8').includes('token'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('native verifier token record is bounded and binds exact identity/PID/time without Claude env leakage',()=>{
 const record=tokenRecord(a,id,'synthetic-scoped-native-token',777,now);assert.equal(record.runId,run);assert.equal(record.taskId,task);assert.equal(record.companyId,COMPANY);assert.equal(record.pid,777);assert.equal(Date.parse(record.expiresAt),a.expiry);
 denied(()=>tokenRecord(a,id,'bad token with spaces',777,now),70);
 const env=childEnvironment(id,a,{});assert.equal(env.HOME,CLAUDE_HOME);assert.equal(env.PAPERCLIP_API_KEY,undefined);assert.equal(env.GH_TOKEN,undefined);assert.equal(env.GITHUB_TOKEN,undefined);assert.equal(env.PAPERCLIP_RUN_ID,run);
});
test('only explicitly approved existing provider context is carried, no route fallback',()=>{
 const metadata={homeContextApproved:true,approvedHomeKind:'api-key-helper',approvedEnvKeys:['ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY'],approvedBaseURL:'https://approved.invalid/v1'};
 const actual=providerEnvironment({ANTHROPIC_BASE_URL:metadata.approvedBaseURL,ANTHROPIC_API_KEY:'synthetic-provider-value',GH_TOKEN:'excluded'},metadata);assert.equal(actual.GH_TOKEN,undefined);assert.equal(actual.ANTHROPIC_BASE_URL,metadata.approvedBaseURL);
 denied(()=>providerEnvironment({ANTHROPIC_BASE_URL:'https://other.invalid'},metadata),70);denied(()=>providerEnvironment({CLAUDE_CODE_OAUTH_TOKEN:'synthetic-unapproved'},metadata),70);
 denied(()=>providerEnvironment({}, {...metadata,homeContextApproved:false}),70);denied(()=>providerEnvironment({}, {...metadata,approvedEnvKeys:['GH_TOKEN']}),70);
 assert.deepEqual(providerEnvironment({}, {homeContextApproved:true,approvedHomeKind:'api-key-helper',approvedEnvKeys:[]}),{});
});
test('scope hook accepts confined product source and exact verifier with inert description',()=>{
 assert.equal(hook('Read',{file_path:'app/sample.mjs'}),0);assert.equal(hook('Read',{file_path:'package.json'}),0);assert.equal(hook('Edit',{file_path:'lib/auth.mjs',old_string:'x',new_string:'y'}),0);assert.equal(hook('Write',{file_path:'app/new.mjs',content:'x'}),0);
 assert.equal(hook('Glob',{pattern:'app/**/*.mjs'}),0);assert.equal(hook('Grep',{path:'app',pattern:'fixture'}),0);
 for(const env of [active,reviewer])assert.equal(hook('Bash',{command:VERIFY,description:'x'.repeat(240)},env),0);
});
test('scope hook remains inert only without a profile and requires correct role/run/cwd',()=>{
 assert.equal(disposition(Buffer.from('{'),{},io),0);for(const change of [{PAPERCLIP_COMPANY_ID:'other'},{PAPERCLIP_AGENT_ID:REVIEWER},{PAPERCLIP_RUN_ID:'bad'},{FARHAN_PAPERCLIP_GUARDED_KIND:'review'},{FARHAN_PAPERCLIP_GUARDED_ROOT:HOME},{FARHAN_PAPERCLIP_GUARDED_PROFILE:'inventory-v1'}])assert.equal(hook('Read',{file_path:'app/sample.mjs'},{...active,...change}),2);
 assert.equal(disposition(event('Read',{file_path:'app/sample.mjs'},HOME),active,io),2);assert.equal(disposition(Buffer.from([0xc3,0x28]),active,io),2);
});
test('reviewer writes only its exact validated receipt and never edits source',()=>{
 const file_path='.claude/it-team-evidence/'+task+'.json';assert.equal(hook('Write',{file_path,content:proof},reviewer),0);
 for(const tool of ['Write','Edit'])assert.equal(hook(tool,{file_path:'app/sample.mjs',content:'x'},reviewer),2);
 assert.equal(hook('Edit',{file_path,old_string:'x',new_string:'y'},reviewer),2);assert.equal(hook('Write',{file_path:file_path.replace(task,run),content:proof},reviewer),2);
 for(const content of ['{}',proof.replace('passed','failed'),proof.replace('"status":','"status":"failed","status":'),proof.replace('b'.repeat(64),'bad')])assert.equal(hook('Write',{file_path,content},reviewer),2);
});
test('scope refuses secrets, operator, Git, dependencies, migrations, configs and controller paths',()=>{
 for(const file_path of [HOME+'/run-auth/'+run+'.json','../app/sample.mjs','app/../lib/auth.mjs','.git/config','.env','app/.env.production','lib/credentials.json','package.json','package-lock.json','supabase/migrations/new.sql','.github/workflows/deploy.yml','data/budgets.json','data/production-config.yaml','scripts/maintenance/controller.mjs','scripts/apiwild-maintenance-controller.mjs'])assert.equal(hook('Write',{file_path,content:'x'}),2,file_path);
 assert.equal(hook('Read',{file_path:HOME+'/provider-context.json'}),2);assert.equal(hook('Glob',{pattern:'**/*'}),2);assert.equal(hook('Grep',{path:root,pattern:'x'}),2);
});
test('scope refuses symlink/hardlink escapes and searches containing private files',()=>{
 const fake=fakeFs();fake.map.get(root+'/app/sample.mjs').kind='link';assert.equal(hook('Read',{file_path:'app/sample.mjs'},active,fake),2);assert.equal(hook('Glob',{path:'app',pattern:'**/*'},active,fake),2);
 fake.map.get(root+'/app/sample.mjs').kind='file';fake.map.get(root+'/app/sample.mjs').nlink=2;assert.equal(hook('Edit',{file_path:'app/sample.mjs',old_string:'x',new_string:'y'},active,fake),2);
 fake.add(root+'/app/.env','file','SYNTHETIC=1');assert.equal(hook('Grep',{path:'app',pattern:'x'},active,fake),2);
});
test('scope rejects all command/tool widening and unsupported metadata',()=>{
 for(const tool of ['ToolSearch','Agent','Task','PowerShell','mcp__stripe__create_customer'])assert.equal(hook(tool,{}),2);
 for(const input of [{command:VERIFY+' && git push'},{command:VERIFY,timeout:1000},{command:VERIFY,env:{}},{command:VERIFY,run_in_background:false},{command:VERIFY,description:'x'.repeat(241)}])assert.equal(hook('Bash',input),2);
 assert.equal(hook('Read',{file_path:'app/sample.mjs',path:HOME}),2);assert.equal(disposition(Buffer.from(event('Read',{file_path:'app/sample.mjs'}).toString().replace('"file_path":','"file_path":"/outside","file_path":')),active,io),2);
});

test('exact receipt compatibility denies hardlinks before allowing reads or writes',()=>{
 const fake=fakeFs(),file_path='.claude/it-team-evidence/'+task+'.json',full=root+'/'+file_path;
 fake.add(full,'file',proof);fake.map.get(full).nlink=2;
 for(const env of [active,reviewer]){assert.equal(hook('Read',{file_path},env,fake),2);assert.equal(hook('Write',{file_path,content:proof},env,fake),2);}
 fake.map.get(full).nlink=1;assert.equal(hook('Read',{file_path},reviewer,fake),0);assert.equal(hook('Write',{file_path,content:proof},reviewer,fake),0);
});
