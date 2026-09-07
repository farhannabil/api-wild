import {resolveMx,resolveTxt} from 'node:dns/promises';
import {appendFileSync} from 'node:fs';
import {spfIncludesProvider} from './spf-health.mjs';

const site='https://apiwild.com';
const support='https://yautmilnpllojugpmfgy.supabase.co/functions/v1/support-inbound';
const checks=[];
async function check(name,fn){
  try{await fn();checks.push({name,ok:true});}
  catch(error){checks.push({name,ok:false,code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'CHECK_FAILED'});}
}
async function request(url,options={}){
  // One bounded retry for network errors or 5xx; never retry auth mutations.
  for(let attempt=0;attempt<2;attempt++){
    try{const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(15000)});if(r.status>=500&&attempt===0)continue;return r;}
    catch(e){if(attempt===1)throw e;}
  }
}
function requireValue(ok){if(!ok)throw Error('check_failed');}
for(const path of ['/','/signup','/login','/forgot-password','/auth/complete']){
  await check(`Page ${path}`,async()=>{const r=await request(site+path);requireValue(r.status===200);const body=await r.text();requireValue(body.includes('API WILD'));});
}
await check('Public auth configuration',async()=>{
  const r=await request(site+'/api/supabase-config');requireValue(r.status===200);
  const body=await r.json();const serialized=JSON.stringify(body);
  requireValue(serialized.includes('yautmilnpllojugpmfgy.supabase.co')&&serialized.includes('sb_publishable_'));
});
await check('Model catalog',async()=>{
  const r=await request(site+'/api/models');requireValue(r.status===200);
  const body=await r.json();requireValue(Array.isArray(body.models)&&body.models.length>0);
});
for(const path of ['/api/account','/api/billing'])await check(`Authentication boundary ${path}`,async()=>{const r=await request(site+path);requireValue(r.status===401);});
await check('Support receiver health',async()=>{const r=await request(support+'/health');requireValue(r.status===200&&(await r.json()).status==='ok');});
await check('Unsigned support event rejected',async()=>{const r=await request(support,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});requireValue(r.status===401);});
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
