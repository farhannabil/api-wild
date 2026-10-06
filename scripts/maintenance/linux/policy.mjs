// Fixed maintenance-only Linux policy. Tests inject filesystem facades into pure
// helpers; the production entry point never accepts alternate paths or binaries.
import fs from 'node:fs';
import path from 'node:path';
export const COMPANY='5b74ebc7-db43-4476-a25c-7d2052881444';
export const BACKEND='1c309634-6f0e-401f-b339-9d0a7ab7e005';
export const REVIEWER='69ee8d9b-0326-4a9b-aedf-634c1f216fc1';
export const HOME='/srv/apiwild-maintenance/operator';
export const CLAUDE_HOME='/srv/apiwild-maintenance/user';
export const INCIDENTS='/srv/apiwild-maintenance/incidents';
export const STATE=HOME+'/guard-state';
export const MANIFEST=HOME+'/jobs.tsv';
export const RUNTIME=CLAUDE_HOME+'/.paperclip/instances/default';
export const NODE='/usr/local/bin/node';
export const CLAUDE='/usr/local/bin/claude';
export const GUARD='/srv/apiwild-maintenance/guard/guardian.mjs';
export const VERIFY='node '+HOME+'/agent-entry.mjs verify-current';
export const REPAIR='maintenance-repair-v1',REVIEW='maintenance-review-v1';
export const repairTools='Read,Glob,Grep,Edit,Write,Bash('+VERIFY+')';
export const reviewTools='Read,Glob,Grep,Write,Bash('+VERIFY+')';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DENIAL='Paperclip maintenance scope denied this tool.';
export class Denied extends Error {constructor(code,kind){super(kind);this.code=code;this.kind=kind;}}
export const refuse=(code,kind)=>{throw new Denied(code,kind);};
export function identity(env){
 if(env.PAPERCLIP_COMPANY_ID!==COMPANY)refuse(70,'company');
 const value={};for(const [key,name] of [['PAPERCLIP_TASK_ID','task'],['PAPERCLIP_AGENT_ID','agent'],['PAPERCLIP_RUN_ID','run']]){
  if(!UUID.test(env[key]??''))refuse(70,'identity');value[name]=env[key];
 }return value;
}
export function canonical(raw,directory,io=fs,{missingLeaf=false}={}){
 if(typeof raw!=='string'||raw.length>1024||!raw.startsWith('/')||raw.startsWith('//')||/[\x00-\x1f\x7f\\]/.test(raw)||raw.split('/').some(x=>x==='.'||x==='..'))refuse(70,'path');
 const normalized=path.posix.resolve(raw);let cursor=normalized,missing=false;
 for(;;){
  try{const stat=io.lstatSync(cursor);if(stat.isSymbolicLink())refuse(70,'path');}
  catch(error){if(error.code!=='ENOENT'||!missingLeaf||missing)refuse(70,'path');missing=true;}
  const parent=path.posix.dirname(cursor);if(parent===cursor)break;cursor=parent;
 }
 const existing=missing?path.posix.dirname(normalized):normalized;
 if(io.realpathSync(existing)!==existing)refuse(70,'path');
 if(!missing){const stat=io.lstatSync(normalized);if(directory?!stat.isDirectory():!stat.isFile())refuse(70,'path');}
 return normalized;
}
export function incidentRoot(raw){return typeof raw==='string'&&raw.startsWith(INCIDENTS+'/')&&UUID.test(raw.slice(INCIDENTS.length+1));}
export function promptDirectory(raw){const prefix=RUNTIME+'/companies/'+COMPANY+'/claude-prompt-cache/';return raw.startsWith(prefix)&&/^[a-f0-9]{64}$/.test(raw.slice(prefix.length));}
export function generatedMcp(agent,run){return RUNTIME+'/companies/'+COMPANY+'/agents/'+agent+'/claude-runtime/runs/'+run+'/mcp/mcp-config.json';}
export function approval(bytes,id,cwd,{now=Date.now(),io=fs}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length>131072)refuse(71,'manifest');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{refuse(71,'manifest');}
 if(text.includes('\0'))refuse(71,'manifest');let found;const seen=new Set();let count=0;
 for(const line of text.replaceAll('\r\n','\n').split('\n')){
  if(!line)continue;if(++count>256)refuse(71,'manifest');const c=line.split('\t');
  if(c.length!==8||!UUID.test(c[0])||!UUID.test(c[1])||seen.has(c[0])||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(c[3])||!Number.isFinite(Date.parse(c[3]))||!/^[1-9]\d*$/.test(c[4])||!/^[1-9]\d*$/.test(c[5]))refuse(71,'manifest');
  seen.add(c[0]);const expiry=Date.parse(c[3]);if(new Date(expiry).toISOString()!==(c[3].includes('.')?c[3]:c[3].slice(0,-1)+'.000Z'))refuse(71,'manifest');const turns=Number(c[4]),seconds=Number(c[5]);
  if(turns>10||seconds<15||seconds>240||c[7]!=='maintenance'||!(c[6]===REPAIR&&c[1]===BACKEND||c[6]===REVIEW&&c[1]===REVIEWER))refuse(71,'manifest');
  if(c[0]===id.task){
   if(c[1]!==id.agent)refuse(71,'approval');const root=canonical(c[2],true,io);
   if(!incidentRoot(root))refuse(71,'cwd');found={task:c[0],agent:c[1],cwd:root,expiry:Date.parse(c[3]),turns,seconds,profile:c[6],kind:c[7]};
  }
 }
 if(!found||found.expiry<=now||found.expiry>now+86400000)refuse(71,'approval');
 if(found.cwd!==canonical(cwd,true,io))refuse(71,'cwd');return found;
}
// JSON.parse silently overwrites duplicate names; this bounded scanner refuses
// duplicates at every object depth before interpreting authority-bearing JSON.
export function parseUnique(text,max=65536){
 if(typeof text!=='string'||Buffer.byteLength(text)>max)refuse(70,'json');let parsed;try{parsed=JSON.parse(text);}catch{refuse(70,'json');}
 let pos=0;const space=()=>{while(pos<text.length&&/\s/.test(text[pos]))pos++;};
 const string=()=>{const start=pos++;while(pos<text.length){const c=text[pos++];if(c==='\\'){pos++;continue;}if(c==='"')return JSON.parse(text.slice(start,pos));}refuse(70,'json');};
 const value=depth=>{if(depth>64)refuse(70,'json');space();if(text[pos]==='"'){string();return;}if(text[pos]==='{'){pos++;space();if(text[pos]==='}'){pos++;return;}const keys=new Set();for(;;){space();const key=string();if(keys.has(key))refuse(70,'json');keys.add(key);space();pos++;value(depth+1);space();if(text[pos++]==='}')return;}}
 else if(text[pos]==='['){pos++;space();if(text[pos]===']'){pos++;return;}for(;;){value(depth+1);space();if(text[pos++]===']')return;}}
 else while(pos<text.length&&!/[\s,}\]]/.test(text[pos]))pos++;};
 value(0);space();if(pos!==text.length)refuse(70,'json');return parsed;
}
export function validateMcp(text){
 const top=parseUnique(text,16384),exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
 if(!exact(top,['mcpServers'])||!exact(top.mcpServers,['Paperclip projects','Paperclip connections']))refuse(70,'mcp-config');
 for(const [name,url]of [['Paperclip projects','http://127.0.0.1:3100/api/mcp/project-tools'],['Paperclip connections','http://127.0.0.1:3100/mcp/runtime-tools']]){
  const s=top.mcpServers[name];if(!exact(s,['type','url','headers'])||s.type!=='http'||s.url!==url||!exact(s.headers,['Authorization'])||typeof s.headers.Authorization!=='string'||!/^Bearer [A-Za-z0-9._~+/-]{16,4087}={0,2}$/.test(s.headers.Authorization))refuse(70,'mcp-config');
 }
}
export function validateArgs(args,a,run,io=fs){
 if(!Array.isArray(args)||args.length<6||args.length>36||args.slice(0,4).join('\0')!=='--print\0--output-format\0stream-json\0--verbose')refuse(70,'arguments');
 const output=args.slice(0,4),seen=new Set();let strict=0,mcp,prompt,dir;
 for(let i=4;i<args.length;i++){
  const flag=args[i];if(flag==='--strict-mcp-config'){if(++strict>1)refuse(70,'mcp');continue;}
  if(seen.has(flag)||++i>=args.length)refuse(70,'arguments');seen.add(flag);const val=args[i];
  if(typeof val!=='string'||!val.length||val.length>1024||/[\x00-\x1f\x7f]/.test(val))refuse(70,'arguments');
  if(flag==='--mcp-config'){mcp=canonical(val,false,io);if(mcp!==generatedMcp(a.agent,run))refuse(70,'mcp');validateMcp(io.readFileSync(mcp,'utf8'));continue;}
  if(flag==='--max-turns'){if(val!==String(a.turns))refuse(70,'turns');}
  else if(flag==='--model'){if(val!=='claude-opus-5')refuse(70,'model');}
  else if(flag==='--effort'){if(!/^(low|medium|high|xhigh|max)$/.test(val))refuse(70,'effort');}
  else if(flag==='--permission-mode'){if(val!==(a.profile===REPAIR?'acceptEdits':'default'))refuse(70,'permissions');}
  else if(flag==='--allowedTools'){if(val!==(a.profile===REPAIR?repairTools:reviewTools))refuse(70,'tools');}
  else if(flag==='--setting-sources'){if(val!=='user')refuse(70,'arguments');}
  else if(flag==='--append-system-prompt-file'){prompt=canonical(val,false,io);if(path.posix.basename(prompt)!=='agent-instructions.md'||!promptDirectory(path.posix.dirname(prompt)))refuse(70,'arguments');}
  else if(flag==='--add-dir'){dir=canonical(val,true,io);if(dir!==a.cwd&&!promptDirectory(dir))refuse(70,'arguments');}
  else refuse(70,'arguments');output.push(flag,val);
 }
 for(const flag of ['--max-turns','--model','--permission-mode','--allowedTools','--setting-sources'])if(!seen.has(flag))refuse(70,'arguments');
 if(!mcp||strict!==1||(prompt&&path.posix.dirname(prompt)!==dir)||(dir&&dir!==a.cwd&&!prompt))refuse(70,'arguments');
 output.push('--tools',a.profile===REPAIR?'Read,Glob,Grep,Edit,Write,Bash':'Read,Glob,Grep,Write,Bash','--mcp-config',mcp,'--strict-mcp-config');return output;
}
export const slotName=index=>{if(index!==0&&index!==1)refuse(73,'capacity');return 'apiwild-maintenance-slot-'+index+'.service';};
export function systemdArgs(slot,a,now=Date.now()){
 const remaining=Math.min(a.seconds*1000,a.expiry-now);if(remaining<=0)refuse(75,'deadline');
 return ['--user','--quiet','--pipe','--wait','--collect','--service-type=exec','--unit='+slotName(slot),'--property=KillMode=control-group','--property=Restart=no',
  '--property=RuntimeMaxSec='+Math.max(1,Math.floor(remaining))+'ms','--property=TimeoutStopSec=5s','--property=WorkingDirectory='+a.cwd,'--',NODE,GUARD,'--guard-service',String(slot)];
}
const providerKeys=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN'];
export function providerEnvironment(env,metadata){
 const keys=metadata?.approvedEnvKeys;if(!Array.isArray(keys)||keys.some(k=>!providerKeys.includes(k))||new Set(keys).size!==keys.length||metadata.homeContextApproved!==true||!['api-key-helper','oauth'].includes(metadata.approvedHomeKind))refuse(70,'provider-context');
 const selected={};for(const key of providerKeys){if(!env[key])continue;if(!keys.includes(key))refuse(70,'provider-context');if(typeof env[key]!=='string'||env[key].length>8192||/[\x00\r\n]/.test(env[key]))refuse(70,'provider-context');selected[key]=env[key];}
 if(selected.ANTHROPIC_BASE_URL!==undefined){let origin;try{origin=new URL(selected.ANTHROPIC_BASE_URL);}catch{refuse(70,'provider-context');}if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||selected.ANTHROPIC_BASE_URL!==metadata.approvedBaseURL)refuse(70,'provider-context');}
 return selected;
}
export function childEnvironment(id,a,provider){return {HOME:CLAUDE_HOME,USER:'apiwild-maintenance',LOGNAME:'apiwild-maintenance',TMPDIR:'/tmp',PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',...provider,PAPERCLIP_COMPANY_ID:COMPANY,PAPERCLIP_AGENT_ID:id.agent,PAPERCLIP_TASK_ID:id.task,PAPERCLIP_RUN_ID:id.run,
 FARHAN_PAPERCLIP_GUARDED_PROFILE:a.profile,FARHAN_PAPERCLIP_GUARDED_KIND:'maintenance',FARHAN_PAPERCLIP_GUARDED_ROOT:a.cwd};}
