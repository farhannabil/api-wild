import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createHandler} from '../supabase/functions/support-inbound/core.mjs';

const secret='whsec_plJ3nmyCDGBKInavdOK15jsl'; // Public Svix fixture, not a credential.
const at=1731705121000;
const handler=createHandler({secret,enabled:false,db:{},provider:{},template:'',now:()=>at});
const request=body=>new Request('https://example.test/support-inbound',{method:'POST',body,duplex:'half'});

test('unsigned oversized chunked support body is canceled before the whole stream is consumed',async()=>{
 let chunks=0,cancelled=false;
 const body=new ReadableStream({
  pull(controller){if(chunks===8){controller.close();return;}chunks++;controller.enqueue(new Uint8Array(65536));},
  cancel(){cancelled=true;}
 },{highWaterMark:0});
 const response=await handler(request(body));
 assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(chunks<=2);
 assert.deepEqual(await response.json(),{error:'too_large'});
});

test('bounded streaming preserves a signed JSON body across split UTF-8 bytes',async()=>{
 const raw=JSON.stringify({type:'unhandled.fixture',note:'café'});
 const bytes=new TextEncoder().encode(raw);
 const body=new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}});
 const id='msg_fixture',timestamp=String(at/1000);
 const signature=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.${raw}`).digest('base64');
 const req=request(body);
 req.headers.set('svix-id',id);req.headers.set('svix-timestamp',timestamp);req.headers.set('svix-signature',`v1,${signature}`);
 const response=await handler(req);
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'ignored'});
});

test('body read failures return a controlled response',async()=>{
 const body=new ReadableStream({start(controller){controller.error(Error('stream interrupted'));}});
 const response=await handler(request(body));
 assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'invalid_body'});
});
