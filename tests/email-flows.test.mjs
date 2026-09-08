import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root=new URL('../',import.meta.url);
const auth=JSON.parse(readFileSync(new URL('supabase/email-templates/manifest.json',root)));
const business=JSON.parse(readFileSync(new URL('emails/transactional/manifest.json',root)));

test('auth emails use branded production callbacks and support contact',()=>{
  assert.equal(auth.length,8);
  for(const item of auth){
    const html=readFileSync(new URL('supabase/email-templates/'+item.file,root),'utf8');
    assert.match(html,/API WILD/);
    assert.match(html,/support@apiwild\.com/);
    assert.doesNotMatch(html,/localhost|127\.0\.0\.1/);
    if(['signup','recovery','magiclink','invite','email_change'].includes(item.type)){
      assert.match(html,/https:\/\/apiwild\.com\/auth\/complete\?token_hash=\{\{ \.TokenHash \}\}/);
      assert.match(html,new RegExp('type='+item.type));
    }
  }
});

test('business emails have HTML and text fallbacks with complete variables',()=>{
  assert.equal(business.templates.length,11);
  for(const item of business.templates){
    const html=readFileSync(new URL('emails/transactional/'+item.html,root),'utf8');
    const text=readFileSync(new URL('emails/transactional/'+item.text,root),'utf8');
    assert.match(html,/API WILD/);assert.match(text,/API WILD/);
    assert.match(html,/support@apiwild\.com/);assert.match(text,/support@apiwild\.com/);
    assert.doesNotMatch(html+text,/localhost|\/console\/keys/);
    for(const variable of item.variables){
      const token='{{'+variable+'}}';assert.ok(html.includes(token),`${item.id} HTML missing ${token}`);assert.ok(text.includes(token),`${item.id} text missing ${token}`);
    }
  }
});

test('only the verified support acknowledgement is enabled',()=>{
  const enabled=business.templates.filter(item=>item.enabled);
  assert.deepEqual(enabled.map(item=>item.id),['support-received']);
  assert.match(enabled[0].verification,/inbox delivery/i);
});

test('financial notices have one canonical sender and custom alternatives stay suppressed',()=>{
  const ownership=business.delivery_ownership;
  assert.equal(ownership.financial_success.sender,'stripe-native');
  assert.equal(ownership.financial_success.notification,'paid-invoice-summary-with-receipt');
  assert.equal(ownership.refund.sender,'stripe-native');
  for(const id of [...ownership.financial_success.custom_templates_suppressed,...ownership.refund.custom_templates_suppressed]){
    const item=business.templates.find(t=>t.id===id);
    assert.equal(item.canonical_sender,'stripe-native');
    assert.equal(item.enabled,false);
  }
  for(const item of business.templates)assert.ok(['stripe-native','apiwild-resend'].includes(item.canonical_sender));
});
