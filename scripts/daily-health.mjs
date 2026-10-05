import {resolveMx,resolveTxt} from 'node:dns/promises';
import {appendFileSync} from 'node:fs';
import {spfIncludesProvider} from './spf-health.mjs';
import {healthRequest as request, requireStatus} from './health-request.mjs';
import {assertLiveness, assertModelCatalog, assertRuntimeConfig, waitForDeployment} from './owned-health-contract.mjs';

const site='https://apiwild.com';
const support='https://yautmilnpllojugpmfgy.supabase.co/functions/v1/support-inbound';
const checks=[];
async function check(name,fn){
  try{await fn();checks.push({name,ok:true});}
  catch(error){checks.push({name,ok:false,code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'CHECK_FAILED'});}
}
function requireValue(ok){if(!ok)throw Error('check_failed');}
if(process.env.APIWILD_EXPECTED_COMMIT){
  await check('Expected Railway deployment active',()=>waitForDeployment({site,expectedCommit:process.env.APIWILD_EXPECTED_COMMIT}));
}
await check('Owned runtime liveness',async()=>{const r=await request(site+'/health/live');requireStatus(r,200);assertLiveness(await r.json());});
for(const path of ['/','/signup','/login','/forgot-password','/auth/complete','/pricing','/models','/console/chat','/console/code','/console/research']){
  await check(`Page ${path}`,async()=>{const r=await request(site+path);requireStatus(r,200);const body=await r.text();requireValue(body.includes('API WILD'));});
}
await check('Public auth configuration',async()=>{
  const r=await request(site+'/api/supabase-config');requireStatus(r,200);
  const body=await r.json();const serialized=JSON.stringify(body);
  requireValue(serialized.includes('yautmilnpllojugpmfgy.supabase.co')&&serialized.includes('sb_publishable_'));
});
let catalogIds;
await check('Model catalog',async()=>{
  const r=await request(site+'/api/models');requireStatus(r,200);
  catalogIds=assertModelCatalog(await r.json());
});
for(const path of ['/api/account','/api/workspace','/api/billing','/api/usage','/api/keys','/api/gateway','/api/gateway/keys','/v1/models','/v1/usage'])await check(`Authentication boundary ${path}`,async()=>{const r=await request(site+path);requireStatus(r,401);});
await check('Gateway route availability contract',async()=>{const r=await request(site+'/api/gateway/config');requireStatus(r,200);assertRuntimeConfig(await r.json(),catalogIds||new Set(),process.env.APIWILD_EXPECTED_COMMIT);});
await check('Gateway invocation requires authentication',async()=>{const r=await request(site+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});requireStatus(r,401);});
// The old maintenance POST mutates Cloudflare D1/AARO and is not mounted in
// Railway's Supabase runtime. A health probe must not execute that legacy job.
// Owned finance sweeping is a separate, still-open launch acceptance item.
await check('Support receiver health',async()=>{const r=await request(support+'/health');requireValue(r.status===200&&(await r.json()).status==='ok');});
await check('Unsigned support event rejected',async()=>{const r=await request(support,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});requireStatus(r,401);});
await check('Support incoming MX',async()=>requireValue((await resolveMx('apiwild.com')).some(r=>r.exchange.replace(/\.$/,'')==='inbound-smtp.us-east-1.amazonaws.com'&&r.priority===10)));
await check('Resend outgoing MX',async()=>requireValue((await resolveMx('send.apiwild.com')).some(r=>r.exchange.replace(/\.$/,'')==='feedback-smtp.us-east-1.amazonses.com')));
await check('Resend SPF',async()=>requireValue(await spfIncludesProvider('send.apiwild.com','amazonses.com',resolveTxt)));
await check('Resend DKIM',async()=>requireValue((await resolveTxt('resend._domainkey.apiwild.com')).some(r=>/p=\S+/.test(r.join('')))));
await check('DMARC record',async()=>requireValue((await resolveTxt('_dmarc.apiwild.com')).some(r=>r.join('').startsWith('v=DMARC1;'))));
// No response bodies, tokens, email addresses, recipient records or secrets in logs.
const report=['API WILD runtime health check',new Date().toISOString(),...checks.map(x=>`${x.ok?'PASS':'FAIL'} ${x.name}${x.code?` (${x.code})`:''}`),'Scope: route health and access controls; paid launch and owned finance maintenance are not certified by this monitor.'].join('\n');
console.log(report);
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,report+'\n');
if(checks.some(x=>!x.ok))process.exitCode=1;
