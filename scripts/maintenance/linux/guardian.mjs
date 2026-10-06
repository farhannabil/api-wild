#!/usr/local/bin/node
// Linux-only two-slot launcher. systemd owns all descendants until the service
// exits; these are same-user guardrails, not an OS sandbox or supplier meter.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {COMPANY,HOME,STATE,MANIFEST,NODE,CLAUDE,GUARD,identity,approval,canonical,validateArgs,parseUnique,slotName,systemdArgs,providerEnvironment,childEnvironment,Denied,refuse} from './policy.mjs';
const SYSTEMD='/usr/bin/systemd-run',SYSTEMCTL='/usr/bin/systemctl';
const PROVIDER_CONTEXT=HOME+'/provider-context.json',AUTH=HOME+'/run-auth';
export function persistExclusive(file,bytes,io=fs){
 let fd;try{fd=io.openSync(file,'wx',0o600);io.writeFileSync(fd,bytes);io.fsyncSync(fd);}
 catch(error){if(error.code==='EEXIST')refuse(72,'intent');throw error;}
 finally{if(fd!==undefined)io.closeSync(fd);}
 const directory=io.openSync(path.posix.dirname(file),'r');try{io.fsyncSync(directory);}finally{io.closeSync(directory);}
}
export function admittedIntent(a,id,now=Date.now()){return JSON.stringify({version:1,task:a.task,agent:a.agent,run:id.run,profile:a.profile,createdAt:new Date(now).toISOString(),expiresAt:new Date(a.expiry).toISOString()})+'\n';}
export function tokenRecord(a,id,token,pid,now=Date.now()){
 if(typeof token!=='string'||token.length<16||token.length>8192||/[\x00-\x20\x7f]/.test(token))refuse(70,'native-token');
 return {version:1,companyId:COMPANY,agentId:id.agent,taskId:id.task,runId:id.run,pid,createdAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(a.expiry,now+a.seconds*1000)).toISOString(),apiKey:token};
}
export function inSlotCgroup(text,slot){return typeof text==='string'&&text.split('\n').some(line=>line.startsWith('0::')&&line.slice(3).split('/').includes(slotName(slot)));}
export function isBusy(stderr,slot){return typeof stderr==='string'&&stderr.split('\n').some(line=>line.includes('Unit '+slotName(slot))&&/already exists|already running/.test(line));}
function trusted(raw,directory=false){const value=canonical(raw,directory);const stat=fs.statSync(value);if(stat.uid!==process.getuid()&&stat.uid!==0||stat.mode&0o022)refuse(70,'ownership');return value;}
async function input(max=2*1024*1024){
 let timer;try{return await Promise.race([(async()=>{const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>max)refuse(70,'input');chunks.push(chunk);}return Buffer.concat(chunks,size);})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Denied(70,'input')),5000);})]);}finally{clearTimeout(timer);}
}
async function occupied(slot){
 return new Promise((resolve,reject)=>{const p=spawn(SYSTEMCTL,['--user','show','--property=ActiveState','--value',slotName(slot)],{env:{HOME,PATH:'/usr/bin:/bin',LANG:'C',XDG_RUNTIME_DIR:'/run/user/'+process.getuid()},stdio:['ignore','pipe','pipe']});let out='',bytes=0;const timer=setTimeout(()=>p.kill('SIGKILL'),5000);p.stdout.on('data',b=>{bytes+=b.length;if(bytes>1024)p.kill('SIGKILL');else out+=b;});p.on('error',reject);p.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Denied(74,'supervisor'));else if(!/^(active|activating|deactivating|inactive|failed)\s*$/.test(out))reject(new Denied(74,'supervisor'));else resolve(!/^(inactive|failed)\s*$/.test(out));});});
}
async function launchService(slot,a,envelope){
 return new Promise((resolve,reject)=>{
  const p=spawn(SYSTEMD,systemdArgs(slot,a),{env:{HOME,PATH:'/usr/bin:/bin',LANG:'C',XDG_RUNTIME_DIR:'/run/user/'+process.getuid()},stdio:['pipe','pipe','pipe']});
  let stderr='',size=0;const timer=setTimeout(()=>p.kill('SIGKILL'),Math.min(a.seconds*1000,Math.max(1,a.expiry-Date.now()))+10000);
  p.stdout.on('data',b=>process.stdout.write(b));p.stderr.on('data',b=>{size+=b.length;if(size<=16384)stderr+=b;});p.stdin.on('error',()=>{});
  p.once('error',error=>{clearTimeout(timer);reject(error);});p.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stderr});});p.stdin.end(envelope);
 });
}
async function outer(args){
 trusted(SYSTEMD);trusted(SYSTEMCTL);trusted(NODE);trusted(GUARD);trusted(CLAUDE);trusted(MANIFEST);trusted(STATE,true);trusted(AUTH,true);
 const socket='/run/user/'+process.getuid()+'/bus';if(!fs.existsSync(socket)||!fs.lstatSync(socket).isSocket())refuse(74,'supervisor');
 const id=identity(process.env),a=approval(fs.readFileSync(MANIFEST),id,process.cwd());validateArgs(args,a,id.run);
 if(fs.existsSync(STATE+'/'+id.task+'.intent'))refuse(72,'intent');
 const provider=providerEnvironment(process.env,parseUnique(fs.readFileSync(trusted(PROVIDER_CONTEXT),'utf8'),16384));
 const prompt=new TextDecoder('utf-8',{fatal:true}).decode(await input());
 const envelope=Buffer.from(JSON.stringify({version:1,args,identity:id,prompt,provider,token:process.env.PAPERCLIP_API_KEY}));
 // systemd's atomic fixed unit names are the two slots. An occupied/cleaning
 // cgroup is never replaced. An ambiguous launch failure is never retried.
 for(const slot of [0,1]){
  if(await occupied(slot))continue;
  const result=await launchService(slot,a,envelope);
  if(result.code===1&&isBusy(result.stderr,slot)&&!fs.existsSync(STATE+'/'+id.task+'.intent'))continue;
  if(result.stderr)process.stderr.write(result.code===0?'':'[paperclip-once] service ended without acceptance\n');
  if(result.signal)refuse(74,'supervisor');return result.code??74;
 }
 refuse(73,'capacity');
}
async function inside(slot){
 if(!inSlotCgroup(fs.readFileSync('/proc/self/cgroup','utf8'),slot))refuse(74,'cgroup');
 trusted(CLAUDE);trusted(MANIFEST);trusted(STATE,true);trusted(AUTH,true);
 const bytes=await input(3*1024*1024);const frame=parseUnique(new TextDecoder('utf-8',{fatal:true}).decode(bytes),3*1024*1024);
 if(!frame||Object.keys(frame).sort().join(',')!=='args,identity,prompt,provider,token,version'||frame.version!==1||typeof frame.prompt!=='string'||Buffer.byteLength(frame.prompt)>2*1024*1024)refuse(70,'input');
 const env={PAPERCLIP_COMPANY_ID:COMPANY,PAPERCLIP_AGENT_ID:frame.identity?.agent,PAPERCLIP_TASK_ID:frame.identity?.task,PAPERCLIP_RUN_ID:frame.identity?.run};
 const id=identity(env);if(Object.keys(frame.identity).sort().join(',')!=='agent,run,task')refuse(70,'identity');
 const a=approval(fs.readFileSync(MANIFEST),id,process.cwd());const args=validateArgs(frame.args,a,id.run);
 const provider=providerEnvironment(frame.provider,parseUnique(fs.readFileSync(trusted(PROVIDER_CONTEXT),'utf8'),16384));
 const record=tokenRecord(a,id,frame.token,process.pid);
 persistExclusive(STATE+'/'+id.task+'.intent',admittedIntent(a,id));
 const authPath=AUTH+'/'+id.run+'.json';let authWritten=false;
 try{
  persistExclusive(authPath,JSON.stringify(record)+'\n');authWritten=true;
  const remaining=Math.min(a.seconds*1000,a.expiry-Date.now());if(remaining<=0)refuse(75,'deadline');
  return await new Promise((resolve,reject)=>{
   const p=spawn(CLAUDE,args,{cwd:a.cwd,env:childEnvironment(id,a,provider),stdio:['pipe','inherit','inherit']});
   const timer=setTimeout(()=>p.kill('SIGKILL'),remaining);p.stdin.on('error',()=>{});
   p.once('error',error=>{clearTimeout(timer);reject(error);});p.once('close',(code,signal)=>{clearTimeout(timer);if(signal)reject(new Denied(75,'deadline'));else resolve(code??74);});p.stdin.end(frame.prompt);
  });
 }finally{
  // systemd KillMode=control-group removes surviving descendants after this
  // MainPID exits, even on SIGKILL. Crash-stale auth records expire; verifier
  // must reject expired records/dead PID and startup cleanup must retain intent.
  if(authWritten)try{fs.unlinkSync(authPath);}catch{}
 }
}
export async function main(args=process.argv.slice(2)){
 try{
  if(process.platform!=='linux'||typeof process.getuid!=='function'||process.getuid()===0)refuse(74,'platform');
  if(args[0]==='--guard-service'){if(args.length!==2||!['0','1'].includes(args[1]))refuse(70,'arguments');process.exitCode=await inside(Number(args[1]));}
  else process.exitCode=await outer(args);
 }catch(error){process.stderr.write('[paperclip-once] denied: '+(error instanceof Denied?error.kind:'runtime')+'\n');process.exitCode=error instanceof Denied?error.code:74;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
