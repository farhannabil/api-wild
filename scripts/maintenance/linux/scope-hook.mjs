import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {COMPANY,BACKEND,REVIEWER,REPAIR,REVIEW,UUID,VERIFY,DENIAL,canonical,incidentRoot,parseUnique} from './policy.mjs';
export const MAX_INPUT_BYTES=65536;
const trees=new Set(['app','lib','tests','data','public','scripts']);
function forbidden(relative){return relative.split('/').some(segment=>!segment||segment.startsWith('.')||/^(?:node_modules|supabase|budgets?|config|configs|deployments?)$/i.test(segment)||
 /(?:^|[-_.])(?:secret|secrets|credential|credentials|private)(?:$|[-_.])/i.test(segment)||/\.(?:pem|key|p12|pfx|keystore)$/i.test(segment)||
 /(?:budget|config|deployment).*(?:\.json|\.ya?ml|\.toml|\.env)$/i.test(segment)||/^(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(segment));}
export function sourcePath(relative,write=false){
 if(!write&&relative==='package.json')return true;if(forbidden(relative))return false;
 const parts=relative.split('/');if(!trees.has(parts[0])&&!(parts[0]==='infra'&&parts[1]==='railway'&&parts[2]==='runtime'))return false;
 if(parts[0]==='scripts'&&parts.some(piece=>/maintenance|controller/i.test(piece)))return false;return true;
}
function identityMatches(env){return env.PAPERCLIP_COMPANY_ID===COMPANY&&UUID.test(env.PAPERCLIP_TASK_ID??'')&&UUID.test(env.PAPERCLIP_RUN_ID??'')&&
 env.FARHAN_PAPERCLIP_GUARDED_KIND==='maintenance'&&incidentRoot(env.FARHAN_PAPERCLIP_GUARDED_ROOT)&&
 (env.FARHAN_PAPERCLIP_GUARDED_PROFILE===REPAIR&&env.PAPERCLIP_AGENT_ID===BACKEND||env.FARHAN_PAPERCLIP_GUARDED_PROFILE===REVIEW&&env.PAPERCLIP_AGENT_ID===REVIEWER);}
function confined(raw,root,write,io){
 if(typeof raw!=='string'||!raw.length||/[\x00-\x1f\x7f\\*?<>|]/.test(raw)||raw.split('/').some(p=>p==='.'||p==='..'))throw Error('path');
 const full=raw.startsWith('/')?raw:path.posix.resolve(root,raw);
 const normalized=canonical(full,false,io,{missingLeaf:write});if(!normalized.startsWith(root+'/'))throw Error('path');return normalized.slice(root.length+1);
}
function searchTree(full,root,io){
 const pending=[full];let count=0;
 while(pending.length){if(++count>50000)throw Error('path');const current=pending.pop(),stat=io.lstatSync(current);
  if(stat.isSymbolicLink())throw Error('path');const real=io.realpathSync(current);
  if(real!==current||!current.startsWith(root+'/')||!sourcePath(current.slice(root.length+1)))throw Error('path');
  if(stat.isDirectory()){for(const item of io.readdirSync(current))pending.push(path.posix.join(current,item));}
  else if(!stat.isFile())throw Error('path');
 }
}
function searchScope(raw,root,io){
 if(typeof raw!=='string'||/[\x00-\x1f\x7f\\*?<>|]/.test(raw)||raw.split('/').some(p=>p==='.'||p==='..'))throw Error('path');
 const full=raw.startsWith('/')?raw:path.posix.resolve(root,raw);const stat=io.lstatSync(full);canonical(full,stat.isDirectory(),io);if(!full.startsWith(root+'/')||!sourcePath(full.slice(root.length+1)))throw Error('path');return full;
}
export function disposition(bytes,env,io=fs){
 if(env.FARHAN_PAPERCLIP_GUARDED_PROFILE===undefined)return 0;
 if(!identityMatches(env)||!Buffer.isBuffer(bytes)||bytes.length>MAX_INPUT_BYTES)return 2;
 try{
  const event=parseUnique(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!event||typeof event!=='object'||Array.isArray(event)||event.hook_event_name!=='PreToolUse'||typeof event.tool_name!=='string'||!event.tool_input||typeof event.tool_input!=='object'||Array.isArray(event.tool_input))return 2;
  const root=canonical(env.FARHAN_PAPERCLIP_GUARDED_ROOT,true,io);if(canonical(event.cwd,true,io)!==root)return 2;
  const input=event.tool_input,tool=event.tool_name;
  if(tool==='Bash')return Object.keys(input).every(k=>k==='command'||k==='description')&&input.command===VERIFY&&(!Object.hasOwn(input,'description')||typeof input.description==='string'&&input.description.length<=240)?0:2;
  const keys={Read:['file_path','offset','limit','pages'],Edit:['file_path','old_string','new_string','replace_all'],Write:['file_path','content'],Glob:['path','pattern'],Grep:['pattern','path','glob','type','output_mode','-A','-B','-C','-i','-n','head_limit','offset','multiline']};
  if(!keys[tool]||Object.keys(input).some(key=>!keys[tool].includes(key)))return 2;
  if(['Read','Edit','Write'].includes(tool)){
   const write=tool!=='Read',relative=confined(input.file_path,root,tool==='Write',io),receipt='.claude/it-team-evidence/'+env.PAPERCLIP_TASK_ID+'.json';
   if(relative===receipt){
    // A hardlinked receipt could share bytes with an operator/private file.
    // Existing receipt leaves must be regular and have one link for either role.
    try{const stat=io.lstatSync(path.posix.resolve(root,relative));if(!stat.isFile()||stat.nlink>1)return 2;}catch(error){if(tool!=='Write'||error.code!=='ENOENT')return 2;}
    if(tool==='Edit')return 2;
    if(tool==='Write'){const value=parseUnique(input.content,16384);if(!value||Object.keys(value).sort().join(',')!=='baseCommit,status,summary,treeDigest'||value.status!=='passed'||typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>4000||!/^[0-9a-f]{40}$/.test(value.baseCommit??'')||!/^[0-9a-f]{64}$/.test(value.treeDigest??''))return 2;}
    return 0;
   }
   if(write&&env.FARHAN_PAPERCLIP_GUARDED_PROFILE!==REPAIR||!sourcePath(relative,write))return 2;
   try{const stat=io.lstatSync(path.posix.resolve(root,relative));if(!stat.isFile()||write&&stat.nlink>1)return 2;}catch(error){if(tool!=='Write'||error.code!=='ENOENT')return 2;}
   return 0;
  }
  let scope=input.path??root;const pattern=tool==='Glob'?input.pattern:input.glob;
  if(pattern!==undefined){if(typeof pattern!=='string'||pattern.length>1024||/[\x00-\x1f\x7f\\:<>|]/.test(pattern)||pattern.split('/').some(p=>p==='.'||p==='..'||p.startsWith('.')))return 2;
   const prefix=pattern.split('/').filter((_,index,all)=>all.slice(0,index+1).every(p=>!/[*?\[\]{}!]/.test(p))).join('/');if(path.posix.resolve(root,scope)===root&&prefix)scope=path.posix.resolve(root,prefix);
  }
  searchTree(searchScope(scope,root,io),root,io);return 0;
 }catch{return 2;}
}
async function main(){
 if(process.env.FARHAN_PAPERCLIP_GUARDED_PROFILE===undefined)return;let timer;
 try{const bytes=await Promise.race([(async()=>{let size=0;const chunks=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX_INPUT_BYTES)throw Error('input');chunks.push(chunk);}return Buffer.concat(chunks,size);})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('input')),5000);})]);if(disposition(bytes,process.env)!==0)throw Error('input');}
 catch{process.stderr.write(DENIAL+'\n');process.exitCode=2;}finally{clearTimeout(timer);process.stdin.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
