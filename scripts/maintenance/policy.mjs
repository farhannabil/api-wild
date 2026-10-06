import {createHash} from 'node:crypto';
export {VERIFY} from './platform.mjs';
import {VERIFY} from './platform.mjs';

export const COMPANY='5b74ebc7-db43-4476-a25c-7d2052881444';
export const BACKEND='1c309634-6f0e-401f-b339-9d0a7ab7e005';
export const REVIEWER='69ee8d9b-0326-4a9b-aedf-634c1f216fc1';
export const REPOSITORY='farhannabil/api-wild';
export const SHA=/^[a-f0-9]{40}$/;
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const repairTools='Read,Glob,Grep,Edit,Write,Bash('+VERIFY+')';
export const reviewTools='Read,Glob,Grep,Write,Bash('+VERIFY+')';
const forbidden=/(^|\/)(?:\.git|\.env[^/]*|node_modules|credentials?|secrets?)(\/|$)|(?:^|\/)[^/]*(?:\.pem|\.key|\.pfx|\.p12)$/i;

// The scheduler cannot publish edits to its own authority, dependency graph,
// hosting settings or database migrations. Product source repairs are allowed.
export function repairPath(file,taskId){
 if(typeof file!=='string'||file.includes('\\')||file.includes('\0')||file.startsWith('/')||file.split('/').some(x=>!x||x==='.'||x==='..')||forbidden.test(file))return false;
 if(file===`.claude/it-team-evidence/${taskId}.json`&&UUID.test(taskId??''))return true;
 return /^(app|lib|tests|data|public|infra\/railway\/runtime|scripts)\//.test(file)&&!file.startsWith('scripts/maintenance/')&&/\.(?:[cm]?[jt]sx?|json|css|svg|md)$/.test(file);
}
export function treeDigest(entries){
 const hash=createHash('sha256');
 for(const entry of [...entries].sort((a,b)=>a.path.localeCompare(b.path))){
  if(typeof entry.path!=='string'||!['file','deleted'].includes(entry.kind))throw Error('invalid_tree');
  hash.update(entry.path+'\0'+entry.kind+'\0');if(entry.kind==='file')hash.update(entry.bytes);hash.update('\0');
 }
 return hash.digest('hex');
}
export function failureFingerprint({commit,failures}){
 if(!SHA.test(commit)||!Array.isArray(failures)||!failures.length||failures.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_ ./:-]{1,160}$/.test(x)))throw Error('invalid_failure');
 return createHash('sha256').update(JSON.stringify({commit,failures:[...new Set(failures)].sort()})).digest('hex');
}
export function observation(previous,snapshot,now){
 if(!SHA.test(snapshot.commit)||!Number.isSafeInteger(now)||!Array.isArray(snapshot.failures))throw Error('invalid_observation');
 if(snapshot.failures.length===0)return{fingerprint:null,consecutive:0,lastCheckedAt:now,action:'healthy'};
 const fingerprint=failureFingerprint(snapshot),consecutive=previous?.fingerprint===fingerprint?(previous.consecutive??0)+1:1;
 return{fingerprint,consecutive,lastCheckedAt:now,action:consecutive>=2?'confirmed_failure':'observe'};
}
export function agentAvailable(agent){
 return agent?.companyId===COMPANY&&['idle','active'].includes(agent.status)&&agent.adapterType==='claude_local'
  &&agent.adapterConfig?.dangerouslySkipPermissions===false&&agent.adapterConfig?.model==='claude-opus-5'
  &&Number.isInteger(agent.budgetMonthlyCents)&&agent.budgetMonthlyCents>0
  &&Number.isInteger(agent.spentMonthlyCents)&&agent.spentMonthlyCents<agent.budgetMonthlyCents;
}
export function validReceipt(value,baseCommit,digest){
 return value?.status==='passed'&&value.baseCommit===baseCommit&&value.treeDigest===digest
  &&typeof value.summary==='string'&&value.summary.length>0&&value.summary.length<=4000;
}
export function parseAttestation(text,baseCommit,digest){
 if(typeof text!=='string'||text.length>7000)throw Error('invalid_attestation');
 const value=JSON.parse(text),keys=Object.keys(value),matches=[...text.matchAll(/(?:^|[,{])\s*("(?:[^"\\]|\\.)*")\s*:/g)].map(x=>JSON.parse(x[1]));
 if(keys.sort().join(',')!=='baseCommit,status,summary,treeDigest'||matches.length!==4||new Set(matches).size!==4||!validReceipt(value,baseCommit,digest))throw Error('invalid_attestation');
 return value;
}
