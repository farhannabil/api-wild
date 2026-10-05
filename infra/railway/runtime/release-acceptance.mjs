// Owner-approved evidence is a reviewed release input, never an enable flag.
// Checkpoint artifacts are private; public status receives only a branded summary.
import {createHash} from 'node:crypto';import fs from 'node:fs/promises';import path from 'node:path';
import {strictObject} from './supabase-gateway-rpc.mjs';
const records=new WeakSet();const fail=()=>Error('release_acceptance_unverified');
export const acceptanceGates=Object.freeze(['customer-session-acceptance','payment-lifecycle-acceptance','supplier-budget-acceptance','supplier-debit-acceptance']);
const checks=Object.freeze({
 'customer-session-acceptance':['productionLogin','ownedDashboard','ownerIsolation'],
 'payment-lifecycle-acceptance':['sandboxPayment','signedWebhookCredit','retailDebit','idempotentReplay','refundReversal','testKeyRevoked','liveConfiguration'],
 'supplier-budget-acceptance':['restrictedProductKey','finiteSharedBudget','modelProviderBindings','noAutomaticTopup','approvedExpiry'],
 'supplier-debit-acceptance':['customerRequestMatched','actualWalletDebit','normalizedCostAudited','holdReconciled','backgroundReconciliation'],
});
const sha=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&!/^([a-f0-9])\1{63}$/.test(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
function models(raw){if(!Array.isArray(raw)||!raw.length||raw.length>39||raw.some(m=>typeof m!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(m))||new Set(raw).size!==raw.length)throw fail();return [...raw].sort();}
function parse(bytes){if(!(bytes instanceof Uint8Array)||bytes.length>32768)throw fail();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
export function verifyReleaseAcceptance({manifestBytes,checkpointBytes,version,configuredModels,conversion,now=Date.now()}={}){
 try{
  const m=parse(manifestBytes);strictObject(m,['schemaVersion','status','version','issuedAt','validUntil','acceptedModels','conversionSha256','checkpoints']);
  if(m.schemaVersion!==1||m.status!=='accepted'||typeof version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(version)||m.version!==version
   ||!iso(m.issuedAt)||!iso(m.validUntil)||!Number.isSafeInteger(now)||Date.parse(m.issuedAt)>now||Date.parse(m.validUntil)<=now
   ||Date.parse(m.validUntil)<=Date.parse(m.issuedAt)||Date.parse(m.validUntil)-Date.parse(m.issuedAt)>30*86400000
   ||!conversion||m.conversionSha256!==conversion.settingsSha256||!hash(m.conversionSha256)||!iso(conversion.observedAt)||!iso(conversion.validUntil)
   ||Date.parse(conversion.observedAt)>Date.parse(m.issuedAt)||Date.parse(m.validUntil)>Date.parse(conversion.validUntil))throw fail();
  const accepted=models(m.acceptedModels);if(JSON.stringify(accepted)!==JSON.stringify(models(configuredModels)))throw fail();
  strictObject(m.checkpoints,acceptanceGates);const seen=new Set();
  for(const gate of acceptanceGates){
   const digest=m.checkpoints[gate];if(!hash(digest)||seen.has(digest))throw fail();seen.add(digest);
   const bytes=checkpointBytes?.[gate];if(!(bytes instanceof Uint8Array)||sha(bytes)!==digest)throw fail();
   const evidence=parse(bytes);strictObject(evidence,['schemaVersion','gate','status','ownerApproved','observedAt','scope','checks','referenceDigests']);
   const scope=gate==='payment-lifecycle-acceptance'?'sandbox-lifecycle-and-live-configuration':gate==='supplier-debit-acceptance'?'genuine-customer-sandbox-request':'production-configuration';
   if(evidence.schemaVersion!==1||evidence.gate!==gate||evidence.status!=='passed'||evidence.ownerApproved!==true||evidence.scope!==scope
    ||!iso(evidence.observedAt)||Date.parse(evidence.observedAt)>Date.parse(m.issuedAt)||Date.parse(m.issuedAt)-Date.parse(evidence.observedAt)>7*86400000
    ||!Array.isArray(evidence.referenceDigests)||!evidence.referenceDigests.length||evidence.referenceDigests.length>20||evidence.referenceDigests.some(d=>!hash(d))
    ||new Set(evidence.referenceDigests).size!==evidence.referenceDigests.length)throw fail();
   strictObject(evidence.checks,checks[gate]);if(checks[gate].some(key=>evidence.checks[key]!==true))throw fail();
  }
  const record=Object.freeze({version:m.version,issuedAt:m.issuedAt,validUntil:m.validUntil,acceptedModels:Object.freeze(accepted),conversionSha256:m.conversionSha256});records.add(record);return record;
 }catch{return null;}
}
export const isReleaseAcceptance=record=>records.has(record);
// Fixed names, no caller-provided evidence paths, no symlinks or secret discovery.
export async function loadReleaseAcceptance({directory,version,configuredModels,conversion,now=Date.now()}={}){
 try{
  const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())return null;
  const read=async name=>{const target=path.join(directory,name),s=await fs.lstat(target);if(!s.isFile()||s.isSymbolicLink()||s.size>32768)throw fail();return fs.readFile(target);};
  const manifestBytes=await read('release-acceptance.json');const manifest=parse(manifestBytes);
  if(manifest.status!=='accepted')return null;
  const checkpointBytes={};for(const gate of acceptanceGates)checkpointBytes[gate]=await read(gate+'.json');
  return verifyReleaseAcceptance({manifestBytes,checkpointBytes,version,configuredModels,conversion,now});
 }catch{return null;}
}
export function releaseAcceptanceState(record,{version,configuredModels,conversion,billingMode,checkoutBillingMode,sweepEnabled,availableModels,now=Date.now()}={}){
 try{
  if(!records.has(record)||version!==record.version||billingMode!=='live'||checkoutBillingMode!=='live'||sweepEnabled!==true||!Number.isSafeInteger(now)
   ||now<Date.parse(record.issuedAt)||now>=Date.parse(record.validUntil)||!conversion||conversion.settingsSha256!==record.conversionSha256
   ||now<Date.parse(conversion.observedAt)||now>=Date.parse(conversion.validUntil)||Date.parse(record.validUntil)>Date.parse(conversion.validUntil)
   ||JSON.stringify(models(configuredModels))!==JSON.stringify(record.acceptedModels)||JSON.stringify(models(availableModels))!==JSON.stringify(record.acceptedModels))return null;
  return Object.freeze({recorded:true,modelCount:record.acceptedModels.length,validUntil:record.validUntil});
 }catch{return null;}
}
