import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/workspace/account-persistence.js',import.meta.url),'utf8');
test('stack saves wait for successful hydration, including failure and retry',async()=>{
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:id==='#save-account-stack',hidden:false,textContent:'',handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}});return nodes.get(id);};
 const requests=[];let settle;const state={stack:new Set()};let renders=0;
 const sandbox={document:{querySelector:node},state,catalog:[{id:'fast'}],renderStack:()=>renders++,toast:()=>{},crypto,FormData,fetch:(url,options)=>{requests.push({url,options});return new Promise(resolve=>settle=resolve);}};
 vm.runInNewContext(source,sandbox);
 const button=node('#save-account-stack');assert.equal(button.disabled,true);
 await button.handlers.click({currentTarget:button});assert.equal(requests.length,1);
 settle({ok:false,json:async()=>({error:'Temporary failure'})});await new Promise(setImmediate);
 assert.equal(button.disabled,true);assert.equal(node('#retry-account-load').hidden,false);
 await button.handlers.click({currentTarget:button});assert.equal(requests.length,1);
 const retry=node('#retry-account-load').handlers.click();
 settle({ok:true,json:async()=>({profile:{stack:'["fast"]'}})});await retry;
 assert.equal(button.disabled,false);assert.equal(state.stack.has('fast'),true);assert.equal(renders,1);
 const saving=button.handlers.click({currentTarget:button});assert.equal(JSON.parse(requests[2].options.body).stack[0],'fast');
 settle({ok:true,json:async()=>({ok:true})});await saving;
});


function fallbackHarness(){
 const nodes=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:id==='#save-account-stack',hidden:false,textContent:'',handlers:{},reportValidity:()=>true,addEventListener(event,fn){this.handlers[event]=fn;}});return nodes.get(id);};
 const requests=[],pending=[],notices=[],state={stack:new Set(['fast'])};
 class BriefFields{get(name){return {business:'Fixture project',goal:'Keep a useful planning brief',type:'Custom model API',volume:'Under 1,000 tasks',autonomy:'Draft for human approval',budget:'100'}[name]}getAll(){return []}}
 vm.runInNewContext(source,{document:{querySelector:node},state,catalog:[{id:'fast'}],renderStack:()=>{},toast:message=>notices.push(message),crypto,FormData:BriefFields,fetch:(url,options)=>{requests.push({url,options});return new Promise(resolve=>pending.push(resolve));}});
 return {node,requests,notices,state,async reply(status,body){assert.ok(pending.length);pending.shift()({status,ok:status>=200&&status<300,json:async()=>body});await new Promise(setImmediate);}};
}

test('401 hydration offers downloads without clearing selections or promising sign-in will enable saves',async()=>{
 const h=fallbackHarness();await h.reply(401,{error:'Sign in to continue.'});
 assert.equal(h.node('#save-account-stack').disabled,true);assert.equal(h.node('#save-account-brief').disabled,true);
 assert.match(h.node('#account-load-status').textContent,/Download stack brief/);assert.match(h.node('#brief-account-status').textContent,/Download my brief/);
 assert.doesNotMatch(h.node('#account-load-status').textContent+h.node('#brief-account-status').textContent,/Sign in|Complete your account/);
 assert.equal(h.node('#retry-account-load').hidden,false);assert.deepEqual([...h.state.stack],['fast']);
 await h.node('#save-account-stack').handlers.click({currentTarget:h.node('#save-account-stack')});
 await h.node('#save-account-brief').handlers.click({currentTarget:h.node('#save-account-brief')});
 assert.equal(h.requests.length,1);
});

test('temporary failures remain retryable and successful legacy stack and brief saves still work',async()=>{
 const h=fallbackHarness();await h.reply(503,{error:'Temporary failure'});
 assert.equal(h.node('#save-account-brief').disabled,false);assert.equal(h.node('#account-load-status').textContent,'Temporary failure');
 const retry=h.node('#retry-account-load').handlers.click();await h.reply(200,{profile:{stack:'["fast"]'}});await retry;
 assert.equal(h.node('#save-account-stack').disabled,false);assert.equal(h.node('#save-account-brief').disabled,false);
 const stack=h.node('#save-account-stack').handlers.click({currentTarget:h.node('#save-account-stack')});
 assert.equal(h.requests.at(-1).url,'/api/account');assert.equal(JSON.parse(h.requests.at(-1).options.body).stack[0],'fast');await h.reply(200,{saved:true});await stack;
 const brief=h.node('#save-account-brief').handlers.click({currentTarget:h.node('#save-account-brief')});
 assert.equal(h.requests.at(-1).url,'/api/briefs');assert.equal(JSON.parse(h.requests.at(-1).options.body).title,'Fixture project');await h.reply(200,{saved:true});await brief;
 assert.equal(h.notices.at(-1),'Brief saved to your account.');assert.equal(h.node('#save-account-stack').disabled,false);assert.equal(h.node('#save-account-brief').disabled,false);
});

test('expired access during either save offers downloads and a later verified legacy session can recover',async()=>{
 const h=fallbackHarness();await h.reply(200,{profile:{stack:'["fast"]'}});
 const stack=h.node('#save-account-stack').handlers.click({currentTarget:h.node('#save-account-stack')});await h.reply(401,{error:'Sign in to save your stack.'});await stack;
 assert.equal(h.node('#save-account-stack').disabled,true);assert.equal(h.node('#save-account-brief').disabled,true);assert.match(h.notices.at(-1),/Download stack brief/);
 const retry=h.node('#retry-account-load').handlers.click();await h.reply(200,{profile:{stack:'["fast"]'}});await retry;
 assert.equal(h.node('#save-account-stack').disabled,false);assert.equal(h.node('#save-account-brief').disabled,false);
 const brief=h.node('#save-account-brief').handlers.click({currentTarget:h.node('#save-account-brief')});await h.reply(401,{error:'Sign in to save a brief.'});await brief;
 assert.equal(h.node('#save-account-stack').disabled,true);assert.equal(h.node('#save-account-brief').disabled,true);assert.match(h.notices.at(-1),/Download my brief/);assert.deepEqual([...h.state.stack],['fast']);
});
