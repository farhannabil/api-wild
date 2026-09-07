import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const module={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/auth-callback.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,URL,URLSearchParams,Error});
const {finishAuthLink,hasAuthLink}=module.exports;
function client(){const calls=[];return {calls,auth:{verifyOtp:async x=>{calls.push(['otp',x]);return {error:null}},exchangeCodeForSession:async x=>{calls.push(['code',x]);return {data:{redirectType:'recovery'},error:null}},setSession:async x=>{calls.push(['session',x]);return {error:null}},getSession:async()=>({data:{session:{user:{id:'fixture'}}},error:null}),getUser:async()=>({data:{user:{id:'fixture',email_confirmed_at:'2026-09-07'}},error:null})}}}
test('implicit recovery fragment imports session and opens password reset without flow query',async()=>{const c=client();assert.equal(await finishAuthLink(c,'https://apiwild.com/auth/complete#access_token=fixture&refresh_token=fixture&type=recovery'),'/reset-password');assert.equal(c.calls[0][0],'session')});
test('token hash explicitly verifies OTP; signup and recovery choose distinct destinations',async()=>{for(const type of ['signup','recovery']){const c=client();assert.equal(await finishAuthLink(c,`https://apiwild.com/auth/complete?token_hash=fixture&type=${type}`),type==='recovery'?'/reset-password':'/onboarding');assert.equal(c.calls[0][0],'otp');assert.equal(c.calls[0][1].type,type)}});
test('PKCE callback explicitly exchanges code and retains recovery result',async()=>{const c=client();assert.equal(await finishAuthLink(c,'https://apiwild.com/auth/complete?code=fixture'),'/reset-password');assert.equal(c.calls[0][0],'code')});
test('expired email never succeeds merely because an older session exists',async()=>{const c=client();await assert.rejects(finishAuthLink(c,'https://apiwild.com/auth/complete#error_code=otp_expired'),/expired/);assert.equal(c.calls.length,0)});
test('incomplete token pair and invalid OTP type are rejected before provider mutation',async()=>{for(const url of ['#access_token=fixture','?token_hash=fixture&type=unknown']){const c=client();await assert.rejects(finishAuthLink(c,'https://apiwild.com/auth/complete'+url),/incomplete/);assert.equal(c.calls.length,0)}});
test('missing or unconfirmed session cannot enter onboarding',async()=>{const c=client();c.auth.getSession=async()=>({data:{session:null},error:null});await assert.rejects(finishAuthLink(c,'https://apiwild.com/auth/complete'),/expired/);const b=client();b.auth.getUser=async()=>({data:{user:{id:'fixture'}},error:null});await assert.rejects(finishAuthLink(b,'https://apiwild.com/auth/complete'),/still needs/)});
test('root fallback recognizes credentials and errors but leaves ordinary pages alone',()=>{assert.equal(hasAuthLink('https://apiwild.com/#access_token=fixture&refresh_token=fixture'),true);assert.equal(hasAuthLink('https://apiwild.com/?error_code=otp_expired'),true);assert.equal(hasAuthLink('https://apiwild.com/?utm_source=email'),false)});
