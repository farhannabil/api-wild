// GitHub CI-only disposable PostgreSQL service; never reads environment DB URLs.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {runAaroStripeDatabaseTests} from './aaro-stripe-database-fixture.mjs';
assert.equal(process.env.CI,'true');assert.equal(process.platform,'linux');
assert.equal(process.argv.length,3);
const {Client}=createRequire(import.meta.url)(process.argv[2]);
const options={host:'127.0.0.1',port:5432,user:'aaro_ci_fixture',password:'synthetic_ci_only',database:'aaro_ci_fixture',ssl:false,connectionTimeoutMillis:5000,query_timeout:15000,options:'-c statement_timeout=10s -c lock_timeout=5s'};
const db=new Client(options);await db.connect();
try{
 const identity=(await db.query("select current_database() as db,current_user as role,current_setting('server_version_num')::integer as version")).rows[0];
 assert.equal(identity.db,'aaro_ci_fixture');assert.equal(identity.role,'aaro_ci_fixture');assert.equal(Math.floor(identity.version/10000),17);
 const concurrent=async(count,work)=>{const clients=Array.from({length:count},()=>new Client(options));try{await Promise.all(clients.map(c=>c.connect()));return await Promise.allSettled(clients.map((c,i)=>work(c,i)));}finally{await Promise.all(clients.map(c=>c.end()));}};
 await runAaroStripeDatabaseTests({db,concurrent});
}finally{await db.end();}
