// Actual isolated PostgreSQL18 source fixtures. No production URL/secret/database or external call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,realpath,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {resolve,basename} from 'node:path';
import {openSync,closeSync} from 'node:fs';
assert.deepEqual(process.argv.slice(2),['--isolated-pg18']);
const bin='C:/Users/farha/.claude/runtime/agent-tools/node_modules/paperclipai/node_modules/@embedded-postgres/windows-x64/native/bin';
const modulePath='C:/Users/farha/.claude/runtime/agent-tools/node_modules/paperclipai/node_modules/pg/lib/index.js';
const fixtureTemp='C:/Users/farha/AppData/Local/Temp';
const {Client}=createRequire(import.meta.url)(modulePath);
const childEnv={SystemRoot:'C:/Windows',PATH:bin+';C:/Windows/System32',TEMP:fixtureTemp,TMP:fixtureTemp};
const fixtureRole='aaro_stripe_test';
const execute=(file,args,accepted=[0])=>new Promise((done,reject)=>{
  const log=absoluteCluster+'-command-'+basename(file)+'.log',fd=openSync(log,'a');
  const child=spawn(file,args,{env:childEnv,windowsHide:true,stdio:['ignore',fd,fd]}),timer=setTimeout(()=>child.kill(),60_000);closeSync(fd);timer.unref();
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',(code,signal)=>{clearTimeout(timer);accepted.includes(code)?done({code}):reject(Object.assign(new Error('Isolated PG command failed: '+basename(file)+'; log '+log),{code,signal}));});
});
for(const file of [bin+'/initdb.exe',bin+'/pg_ctl.exe',modulePath])assert.equal((await stat(file)).isFile(),true);
const cluster=await mkdtemp(fixtureTemp+'/aaro-stripe-pg-'),absoluteCluster=resolve(await realpath(cluster));
const validCluster=()=>assert.match(absoluteCluster.replaceAll('\\','/'),/^C:\/Users\/farha\/AppData\/Local\/Temp\/aaro-stripe-pg-[A-Za-z0-9]+$/);
validCluster();
const port=await new Promise((done,reject)=>{const probe=createServer();probe.on('error',reject);probe.listen(0,'127.0.0.1',()=>{const address=probe.address();assert.ok(address&&typeof address!=='string');probe.close(error=>error?reject(error):done(address.port));});});
const options={host:'127.0.0.1',port,user:fixtureRole,database:'postgres',password:()=>'',ssl:false,connectionTimeoutMillis:5000,query_timeout:15000,options:'-c statement_timeout=10s -c lock_timeout=5s'};
let started=false,db,cleanupPromise;
async function stopFixture(interrupted=false){
  cleanupPromise??=(async()=>{
    if(interrupted)db?.on('error',()=>{});else await db?.end();
    if(started){validCluster();assert.equal(resolve(await realpath(absoluteCluster)),absoluteCluster);
      const stopped=await execute(bin+'/pg_ctl.exe',['-D',absoluteCluster,'-m','fast','-w','stop']);
      const status=await execute(bin+'/pg_ctl.exe',['-D',absoluteCluster,'status'],[3]);started=false;
      console.log(JSON.stringify({fixtureStopped:stopped.code===0,statusExit:status.code,retainedData:true,cluster:absoluteCluster}));
    }
    if(interrupted)await db?.end();
  })();return cleanupPromise;
}
const wallClock=setTimeout(()=>{console.error('Isolated AARO finance test deadline reached.');void stopFixture(true).then(()=>process.exit(124),()=>process.exit(125));},180000);wallClock.unref();
import {runAaroStripeDatabaseTests} from './aaro-stripe-database-fixture.mjs';
async function concurrent(count,work){
 const clients=Array.from({length:count},()=>new Client(options));
 try{await Promise.all(clients.map(c=>c.connect()));return await Promise.allSettled(clients.map((c,i)=>work(c,i)));}
 finally{await Promise.all(clients.map(c=>c.end()));}
}
try{
 await execute(bin+'/initdb.exe',['-D',absoluteCluster,'-U',fixtureRole,'-A','trust','--encoding=UTF8','--no-locale','--no-sync']);
 await execute(bin+'/pg_ctl.exe',['-D',absoluteCluster,'-l',absoluteCluster+'/fixture.log','-o','-h 127.0.0.1 -p '+port,'-w','start']);started=true;
 db=new Client(options);await db.connect();
 const identity=(await db.query("select current_setting('data_directory') as path,current_setting('server_version_num')::integer as version,current_user as owner")).rows[0];
 assert.equal(resolve(await realpath(identity.path)),absoluteCluster);assert.equal(identity.owner,fixtureRole);assert.equal(Math.floor(identity.version/10000),18);
 await runAaroStripeDatabaseTests({db,concurrent});
}finally{clearTimeout(wallClock);await stopFixture();}
