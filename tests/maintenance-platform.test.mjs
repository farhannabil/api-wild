import test from'node:test';import assert from'node:assert/strict';
import{LINUX,HOME,INCIDENTS,GUARD,VERIFY,normal,childEnvironment}from'../scripts/maintenance/platform.mjs';
test('fixed platform paths retain Linux case and Windows compatibility',()=>{
 assert.equal(LINUX,process.platform==='linux');
 if(LINUX){assert.equal(HOME,'/srv/apiwild-maintenance/operator');assert.equal(INCIDENTS,'/srv/apiwild-maintenance/incidents');assert.equal(GUARD,'/srv/apiwild-maintenance/guard/guardian.mjs');assert.equal(normal('/srv/APIWILD'),' /srv/APIWILD'.trim());assert.equal(VERIFY,'node /srv/apiwild-maintenance/operator/agent-entry.mjs verify-current');}
 else{assert.equal(HOME,'C:/Users/farha/.claude/it-team/apiwild-autonomy');assert.equal(normal('C:/Case/Path'),'c:/case/path');}
});
test('platform environment is an allowlist and cannot inherit control-plane or supplier secrets',()=>{
 const keys=['GH_TOKEN','DATABASE_URL','PAPERCLIP_API_KEY','ANTHROPIC_API_KEY','STRIPE_SECRET_KEY'];const old=keys.map(x=>process.env[x]);
 try{keys.forEach(x=>process.env[x]='fixture-secret');const env=childEnvironment();for(const key of keys)assert.equal(env[key],undefined);assert.equal(env.PATH.includes(LINUX?':':';'),true);assert.deepEqual(childEnvironment({EXACT_ALLOWED_FIXTURE:'yes'}).EXACT_ALLOWED_FIXTURE,'yes');}
 finally{keys.forEach((x,i)=>old[i]===undefined?delete process.env[x]:process.env[x]=old[i]);}
});
