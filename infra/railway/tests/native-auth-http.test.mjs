import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createNativeSessionStore} from '../runtime/native-session-store.mjs';
import {createNativeAuthHttp} from '../runtime/native-auth-http.mjs';
import {createPreparationServer} from '../preparation-server.mjs';
import {request} from 'node:http';
test('bounded private TTL store copies records and expires them',async()=>{
 let now=100;const store=createNativeSessionStore({maxSessions:1,now:()=>now});const key='a'.repeat(64),value={userId:2,sessionCookie:'session=secret',expiresAt:200};
 await store.put(key,value);value.sessionCookie='changed';assert.equal((await store.get(key)).sessionCookie,'session=secret');
 await assert.rejects(store.put('b'.repeat(64),{...value,expiresAt:200}));now=201;assert.equal(await store.get(key),undefined);
 await store.put('b'.repeat(64),{...value,expiresAt:300});assert.equal(await createNativeSessionStore().get(key),undefined);
});
async function call(server,path,host='apiwild.com'){
 return new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path,headers:{host}},res=>{let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end();});
}
test('real HTTP mount defaults disabled and retains closed inference',async()=>{
 const server=createPreparationServer({nativeAuthHttp:createNativeAuthHttp()});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{assert.equal((await call(server,'/api/native/auth/self')).body.error,'native_auth_disabled');assert.equal((await call(server,'/v1/models')).status,503);assert.equal((await call(server,'/api/native/auth/self','evil.example')).status,403);}finally{await new Promise(resolve=>server.close(resolve));}
});
test('real HTTP native self resolves private session and projects account only',async()=>{
 const store=createNativeSessionStore();await store.put(createHash('sha256').update('a'.repeat(64)).digest('hex'),{userId:2,sessionCookie:'session=secret',expiresAt:Date.now()+60000});
 const port=createNativeAuthHttp({enabled:true,sessionStore:store,fetchImpl:async(url,options)=>{assert.equal(url,'https://apiwild.subrouter.ai/api/dist/user/self');assert.equal(options.headers.cookie,'session=secret');return Response.json({success:true,data:{id:2,username:'customer',access_token:'hidden'}});}});
 const server=createPreparationServer({nativeAuthHttp:port});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const result=await new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/native/auth/self',headers:{host:'apiwild.com',cookie:'__Host-apiwild_native='+ 'a'.repeat(64)}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();});assert.equal(result.status,200);assert.match(result.body,/customer/);assert.doesNotMatch(result.body,/secret|hidden|sessionCookie/);}finally{await new Promise(resolve=>server.close(resolve));}
});
