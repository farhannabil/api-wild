import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
function setup(){const sql=new DatabaseSync(':memory:');for(const f of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')))sql.exec(fs.readFileSync('drizzle/'+f,'utf8'));
const db={prepare(query){
 let args=[];
 return {
  bind(...a){args=a;return this;},
  async first(){return sql.prepare(query).get(...args)||null;},
  async all(){return {results:sql.prepare(query).all(...args)};},
  async run(){const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}};}
 };
}};
const cache={};function load(path){if(cache[path])return cache[path];const text=fs.readFileSync(path,'utf8');const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const module={exports:{}};vm.runInNewContext(js,{module,exports:module.exports,require:n=>n==='cloudflare:workers'?{env:{DB:db}}:n==='@/db/service'?load('db/service.ts'):require(n),Response,Request,URL,TextDecoder,console,Date,Error,SyntaxError,Set},{filename:path});cache[path]=module.exports;return module.exports}return {account:load('app/api/account/route.ts'),briefs:load('app/api/briefs/route.ts'),sql}}
function request(path,method='GET',body,user='fixture-a',origin='https://example.test'){const headers={};if(user){headers['oai-authenticated-user-id']=user;headers['oai-authenticated-user-email']=user+'@example.test'}if(method!=='GET'){headers.origin=origin;headers['content-type']='application/json'}return new Request('https://example.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)})}
const profile={name:'Fixture User',company:'Fixture Project',useCase:'Model APIs',budget:100};
test('anonymous calls cannot read or write profiles and briefs',async()=>{const a=setup();for(const [route,path] of [[a.account,'/api/account'],[a.briefs,'/api/briefs']]){assert.equal((await route.GET(request(path,'GET',undefined,null))).status,401);assert.equal((await route.POST(request(path,'POST',profile,null))).status,401)}assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM profiles').get().n,0)});
test('profile upsert, persistent stack and tenant isolation',async()=>{const a=setup();for(let i=0;i<2;i++)assert.equal((await a.account.POST(request('/api/account','POST',{...profile,user_id:'fixture-b'}))).status,200);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM profiles').get().n,1);assert.equal((await a.account.PUT(request('/api/account','PUT',{stack:['fast','reason','fast']}))).status,200);const result=await a.account.GET(request('/api/account'));assert.equal(result.headers.get('cache-control'),'private, no-store');assert.deepEqual(JSON.parse((await result.json()).profile.stack),['fast','reason']);assert.equal((await (await a.account.GET(request('/api/account','GET',undefined,'fixture-b'))).json()).profile,null);assert.equal((await a.account.PUT(request('/api/account','PUT',{stack:['code']},'fixture-b'))).status,409)});
test('invalid and cross-origin changes are rejected',async()=>{const a=setup();assert.equal((await a.account.POST(request('/api/account','POST',profile,'fixture-a','https://evil.test'))).status,403);for(const p of [null,[],{...profile,budget:-1},{...profile,name:''},{...profile,useCase:'unknown'}])assert.equal((await a.account.POST(request('/api/account','POST',p))).status,400);assert.equal((await a.account.PUT(request('/api/account','PUT',{stack:['fake-model']}))).status,400);assert.equal((await a.account.POST(request('/api/account','POST',{...profile,name:'x'.repeat(9000)}))).status,413)});
test('brief saves are idempotent per owner and never exposed to another owner',async()=>{const a=setup(),brief={id:'fa579da1-8c91-4f78-8f0f-ef8d79ddbb36',title:'Fixture brief',content:'A fixture-only sample business workflow.'};for(let i=0;i<2;i++)assert.equal((await a.briefs.POST(request('/api/briefs','POST',brief))).status,200);assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM briefs').get().n,1);assert.equal((await (await a.briefs.GET(request('/api/briefs','GET',undefined,'fixture-b'))).json()).briefs.length,0);assert.equal((await a.briefs.POST(request('/api/briefs','POST',{...brief,title:'Other fixture'},'fixture-b'))).status,200);assert.equal((await (await a.briefs.GET(request('/api/briefs'))).json()).briefs[0].title,'Fixture brief')});
