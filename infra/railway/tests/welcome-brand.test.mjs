import test from 'node:test';
import assert from 'node:assert/strict';
import {claimConfirmedWelcome} from '../runtime/welcome-rpc.mjs';
import {processWelcomeOutbox} from '../resend-outbox.mjs';
const job={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',lease_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',brand_slug:'apiwild',recipient:'fixture@example.test',template:'confirmed-welcome-v1'};
const secret='sb_secret_syntheticFixtureOnly000000';
test('API WILD claim uses the brand-scoped SQL and modern secret never becomes a bearer JWT',async()=>{
  let count=0;
  const result=await claimConfirmedWelcome({serviceRoleKey:secret,limit:1,brand:'apiwild',fetchImpl:async(url,init)=>{
    count++;assert.equal(url,'https://yautmilnpllojugpmfgy.supabase.co/rest/v1/rpc/claim_apiwild_confirmed_welcome');
    assert.equal(init.headers.apikey,secret);assert.equal(init.headers.Authorization,undefined);
    assert.deepEqual(JSON.parse(init.body),{p_limit:1});return Response.json([job]);
  }});
  assert.equal(count,1);assert.equal(result[0].brand_slug,'apiwild');
});
test('foreign brand in claimed response cannot reach Resend or change a queue receipt',async()=>{
  const calls=[];
  await assert.rejects(processWelcomeOutbox({env:{EMAIL_AUTOMATION_ENABLED:'true',WELCOME_BRAND:'apiwild',SUPABASE_URL:'https://yautmilnpllojugpmfgy.supabase.co',SUPABASE_SERVICE_ROLE_KEY:secret,RESEND_API_KEY:'re_synthetic'},fetchImpl:async(url)=>{
    calls.push(url);return Response.json([{...job,brand_slug:'aaro'}]);
  }}),/email_queue_receipt_invalid/);
  assert.deepEqual(calls,['https://yautmilnpllojugpmfgy.supabase.co/rest/v1/rpc/claim_apiwild_confirmed_welcome']);
});
test('unknown brand rejected before queue claim and disabled service stays inert',async()=>{
  await assert.rejects(claimConfirmedWelcome({serviceRoleKey:secret,limit:1,brand:'unknown',fetchImpl:()=>assert.fail()}),{code:'invalid_brand_scope'});
  assert.deepEqual(await processWelcomeOutbox({env:{WELCOME_BRAND:'apiwild',EMAIL_AUTOMATION_ENABLED:'false'},fetchImpl:()=>assert.fail()}),{enabled:false,claimed:0});
});
