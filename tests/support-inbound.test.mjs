import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {verifyWebhook,replyPolicy,buildReply,createHandler} from '../supabase/functions/support-inbound/core.mjs';
import deployedTemplate from '../supabase/functions/support-inbound/template.mjs';

const secret='whsec_plJ3nmyCDGBKInavdOK15jsl'; // Published Svix test vector, NOT a credential.
const id='00000000-0000-4000-8000-000000000001';
const email={id,from:'Test <customer@example.com>',to:['support@apiwild.com'],subject:'Help <script>',headers:{'Auto-Submitted':'no'},message_id:'<fixture@example.com>'};
const template=readFileSync(new URL('../emails/transactional/support-received.html',import.meta.url),'utf8');
test('deployed support template matches the business template',()=>assert.equal(deployedTemplate,template));
const at=1731705121000;
function signed(event={type:'email.received',data:{email_id:id,to:email.to}}) {
  const body=JSON.stringify(event),ts=String(at/1000),eventId='msg_fixture';
  const signature=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${eventId}.${ts}.${body}`).digest('base64');
  return new Request('https://example.com/support-inbound',{method:'POST',body,headers:{'svix-id':eventId,'svix-timestamp':ts,'svix-signature':`v1,${signature}`}});
}
test('Svix official test vector, modified payload and stale/future timestamp rejection',()=>{
  const payload='{"event_type":"ping","data":{"success":true}}';
  const headers=new Headers({'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='});
  assert.equal(verifyWebhook(payload,headers,secret,at).event_type,'ping');
  assert.throws(()=>verifyWebhook(payload+' ',headers,secret,at));
  assert.throws(()=>verifyWebhook(payload,headers,secret,at+301000));
  assert.throws(()=>verifyWebhook(payload,headers,secret,at-301000));
});
test('support replies suppress automation, own mail, bulk, follow-ups and other recipients',()=>{
  assert.equal(replyPolicy(email).reason,null);
  for(const change of [{from:'support@apiwild.com'},{from:'no-reply@example.com'},{from:'a@example.com, b@example.com'},{to:['other@apiwild.com']},{headers:{'Auto-Submitted':'auto-replied'}},{headers:{'Return-Path':'<>'}},{headers:{Precedence:'bulk'}},{headers:{'List-ID':'list'}},{headers:{'In-Reply-To':'<old>'}}]) assert.ok(replyPolicy({...email,...change}).reason);
});
test('acknowledgement escapes untrusted subject, sends no body/secret and routes replies to support',()=>{
  const result=buildReply({...email,text:'SECRET_DO_NOT_ECHO'},'customer@example.com',template);
  assert.match(result.html,/Help &lt;script&gt;/);
  assert.ok(!JSON.stringify(result).includes('SECRET_DO_NOT_ECHO'));
  assert.equal(result.reply_to,'support@apiwild.com');
  assert.equal(result.headers['Auto-Submitted'],'auto-replied');
  assert.equal(result.headers['In-Reply-To'],'<fixture@example.com>');
});
test('invalid or disabled webhook cannot call provider/database',async()=>{
  const unexpected=()=>{throw Error('unexpected side effect');};
  const handler=createHandler({secret,enabled:false,db:{claim:unexpected},provider:{receive:unexpected},template,now:()=>at});
  assert.equal((await handler(new Request('https://example.com',{method:'POST',body:'{}'}))).status,401);
  assert.equal((await handler(signed())).status,503);
});
test('replay sends once, concurrency lease requests retry, and lost completion reuses identical provider key/payload',async()=>{
  let state='new',savedPayload,loseCompletion=true,sends=0,receiveCount=0;
  const providerLedger=new Map();
  const db={claim:async(_id,_hash,payload)=>{
    if(state==='sent') return {action:'done'};
    if(state==='busy') return {action:'busy'};
    savedPayload ||=payload; state='busy'; return {action:'send',lease_id:'lease',payload:savedPayload};
  },complete:async()=>{if(loseCompletion){loseCompletion=false;return false;}state='sent';return true;}};
  const provider={receive:async()=>{receiveCount++;return email;},send:async(payload,key)=>{
    if(providerLedger.has(key)) assert.deepEqual(providerLedger.get(key),payload);
    else {providerLedger.set(key,payload);sends++;}
    return {id};
  }};
  const handler=createHandler({secret,enabled:true,db,provider,template,now:()=>at});
  assert.equal((await handler(signed())).status,503);
  assert.equal((await handler(signed())).status,503); // lease still held
  state='retry'; // simulate lease expiry
  assert.equal((await handler(signed())).status,200);
  assert.equal((await handler(signed())).status,200);
  assert.equal(sends,1); assert.equal(receiveCount,4);
});
