import {resolveMx,resolveTxt} from 'node:dns/promises';
import {appendFileSync} from 'node:fs';
import {spfIncludesProvider} from './spf-health.mjs';
import {healthRequest as request, requireStatus} from './health-request.mjs';

const site='https://apiwild.com';
const support='https://yautmilnpllojugpmfgy.supabase.co/functions/v1/support-inbound';
const checks=[];
async function check(name,fn){
  try{await fn();checks.push({name,ok:true});}
  catch(error){checks.push({name,ok:false,code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'CHECK_FAILED'});}
}
function requireValue(ok){if(!ok)throw Error('check_failed');}
for(const path of ['/','/signup','/login','/forgot-password','/auth/complete','/pricing','/models','/console/chat','/console/code','/console/research']){
  await check(`Page ${path}`,async()=>{const r=await request(site+path);requireStatus(r,200);const body=await r.text();requireValue(body.includes('API WILD'));});
}
await check('Public auth configuration',async()=>{
  const r=await request(site+'/api/supabase-config');requireStatus(r,200);
  const body=await r.json();const serialized=JSON.stringify(body);
  requireValue(serialized.includes('yautmilnpllojugpmfgy.supabase.co')&&serialized.includes('sb_publishable_'));
});
await check('Model catalog',async()=>{
  const r=await request(site+'/api/models');requireStatus(r,200);
  const body=await r.json();requireValue(Array.isArray(body.models)&&body.models.length>0);
});
for(const path of ['/api/account','/api/workspace','/api/billing','/api/usage','/api/keys','/api/gateway','/api/gateway/keys','/v1/models','/v1/usage'])await check(`Authentication boundary ${path}`,async()=>{const r=await request(site+path);requireStatus(r,401);});
await check('Gateway route availability contract',async()=>{const r=await request(site+'/api/gateway/config');requireStatus(r,200);const c=await r.json();requireValue(c.models?.length===3&&['chat','code','research','voice'].every(k=>typeof c.ready?.[k]==='boolean'));requireValue(!JSON.stringify(c).includes('API_KEY'));});
await check('Gateway invocation requires authentication',async()=>{const r=await request(site+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});requireStatus(r,401);});
if(process.env.APIWILD_GATEWAY_OPERATIONS_SECRET){await check('Gateway scheduled maintenance',async()=>{const r=await request(site+'/api/gateway/maintenance',{method:'POST',headers:{Authorization:'Bearer '+process.env.APIWILD_GATEWAY_OPERATIONS_SECRET}});requireStatus(r,200);requireValue(Array.isArray((await r.json()).states));});}
else checks.push({name:'Gateway scheduled maintenance',ok:false,code:'OPERATIONS_SECRET_MISSING'});
await check('Support receiver health',async()=>{const r=await request(support+'/health');requireValue(r.status===200&&(await r.json()).status==='ok');});
await check('Unsigned support event rejected',async()=>{const r=await request(support,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});requireStatus(r,401);});
await check('Support incoming MX',async()=>requireValue((await resolveMx('apiwild.com')).some(r=>r.exchange.replace(/\.$/,'')==='inbound-smtp.us-east-1.amazonaws.com'&&r.priority===10)));
await check('Resend outgoing MX',async()=>requireValue((await resolveMx('send.apiwild.com')).some(r=>r.exchange.replace(/\.$/,'')==='feedback-smtp.us-east-1.amazonses.com')));
await check('Resend SPF',async()=>requireValue(await spfIncludesProvider('send.apiwild.com','amazonses.com',resolveTxt)));
await check('Resend DKIM',async()=>requireValue((await resolveTxt('resend._domainkey.apiwild.com')).some(r=>/p=\S+/.test(r.join('')))));
await check('DMARC record',async()=>requireValue((await resolveTxt('_dmarc.apiwild.com')).some(r=>r.join('').startsWith('v=DMARC1;'))));
// No response bodies, tokens, email addresses, recipient records or secrets in logs.
const report=['API WILD health check',new Date().toISOString(),...checks.map(x=>`${x.ok?'PASS':'FAIL'} ${x.name}${x.code?` (${x.code})`:''}`)].join('\n');
console.log(report);
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,report+'\n');
if(checks.some(x=>!x.ok))process.exitCode=1;
