import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './lifecycle.test.mjs';
const owner='live:supabase:fixture',other='live:supabase:other',hash='a'.repeat(64),model='openai/fixture';
function fixture(credits=1000){
 const a=setup({AARO_USAGE_ENABLED:'true',AARO_TARIFF_VERSION:'aaro-token-units-2026-09-27.draft-1'}),usage=a.load('lib/aaro-usage.ts'),now=Math.floor(Date.now()/1000);
 function grant(who=owner,invoice='in_fixture',amount=credits){
  a.sql.prepare('INSERT INTO aaro_checkouts(id,user_id,active_owner,plan_id,subscription_id,status,created_at) VALUES(?,?,?,?,?,?,?)').run('checkout_'+invoice,who,who,'global-starter','sub_'+invoice,'active',new Date().toISOString());
  a.sql.prepare('INSERT INTO aaro_credit_periods VALUES(?,?,?,?,?,?,?,?)').run(invoice,who,'sub_'+invoice,'global-starter',amount,now-60,now+3600,new Date().toISOString());
 }
 grant();return {...a,usage,grant,reserve:(key='request-0001',maximum=600,who=owner)=>usage.reserveAaroUsage(who,key,hash,model,maximum)};
}
test('AARO usage requires explicit enabled flag and exact draft tariff; accounting remains separate',async()=>{
 const f=fixture();assert.equal(f.usage.aaroCredits(10,20),90);
 for(const bad of [NaN,-1,1.2,Infinity])assert.throws(()=>f.usage.aaroCredits(bad,1));
 f.env.AARO_USAGE_ENABLED='false';await assert.rejects(()=>f.reserve(),e=>e.status===503);
 f.env.AARO_USAGE_ENABLED='true';f.env.AARO_TARIFF_VERSION='unaccepted';await assert.rejects(()=>f.reserve(),e=>e.status===503);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM aaro_usage_requests').get().n,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM credit_ledger').get().n,0);
});
test('AARO concurrent distinct reservations cannot overdraw one invoice',async()=>{
 const f=fixture(),results=await Promise.allSettled([f.reserve('request-1111'),f.reserve('request-2222')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await f.usage.aaroUsageTotals(owner)).available,400);
 assert.equal(f.sql.prepare('SELECT SUM(reserved_credits) n FROM aaro_usage_requests').get().n,600);
});
test('AARO duplicate requests share one reservation and can only claim once',async()=>{
 const f=fixture(),results=await Promise.all([f.reserve(),f.reserve()]);assert.equal(results[0].record.id,results[1].record.id);assert.equal(results.filter(r=>r.fresh).length,1);
 const id=results[0].record.id,claims=await Promise.all([f.usage.claimAaroUsage(owner,id),f.usage.claimAaroUsage(owner,id)]);assert.equal(claims.filter(Boolean).length,1);
 await assert.rejects(()=>f.usage.reserveAaroUsage(owner,'request-0001','b'.repeat(64),model,600),e=>e.status===409);
 await assert.rejects(()=>f.usage.reserveAaroUsage(owner,'request-0001',hash,model,500),e=>e.status===409);
});
test('AARO owner and test/live boundaries hold across balances, claim and settlement',async()=>{
 const f=fixture(),{record}=await f.reserve();assert.equal((await f.usage.aaroUsageTotals(other)).available,0);assert.equal((await f.usage.aaroUsageTotals('test:supabase:fixture')).available,0);
 assert.equal(await f.usage.claimAaroUsage(other,record.id),null);
 await assert.rejects(()=>f.usage.settleAaroUsage(other,record.id,{state:'failed'}),e=>e.status===404);
 await assert.rejects(()=>f.usage.uncertainAaroUsage(other,record.id),e=>e.status===404);
 await assert.rejects(()=>f.reserve('request-0001',600,other),e=>e.status===402);
 f.grant(other,'in_other');const second=await f.reserve('request-0001',600,other);assert.notEqual(second.record.id,record.id);
});
test('AARO expired, cancelled, future and payment-held invoice grants cannot fund requests',async()=>{
 for(const change of [f=>f.sql.prepare('UPDATE aaro_credit_periods SET period_end=?').run(Math.floor(Date.now()/1000)),f=>f.sql.prepare("UPDATE aaro_checkouts SET status='canceled'").run(),f=>f.sql.prepare('UPDATE aaro_credit_periods SET period_start=?').run(Math.floor(Date.now()/1000)+600),f=>f.sql.prepare('INSERT INTO aaro_payment_holds VALUES(?,?,?)').run('in_fixture','refund-review',new Date().toISOString())]){
  const f=fixture();change(f);await assert.rejects(()=>f.reserve(),e=>e.status===402);assert.equal((await f.usage.aaroUsageTotals(owner)).available,0);
 }
 const f=fixture(),{record}=await f.reserve();f.sql.prepare('INSERT INTO aaro_payment_holds VALUES(?,?,?)').run('in_fixture','dispute-review',new Date().toISOString());assert.equal(await f.usage.claimAaroUsage(owner,record.id),null);
});
test('AARO successful settlement charges actual token units once, releases excess and rejects conflicting replay',async()=>{
 const f=fixture(),{record}=await f.reserve();await f.usage.claimAaroUsage(owner,record.id);
 const result={state:'succeeded',inputTokens:20,outputTokens:30};await Promise.all([f.usage.settleAaroUsage(owner,record.id,result),f.usage.settleAaroUsage(owner,record.id,result)]);
 const totals=await f.usage.aaroUsageTotals(owner);assert.equal(totals.spent,140);assert.equal(totals.reserved,0);assert.equal(totals.available,860);
 await assert.rejects(()=>f.usage.settleAaroUsage(owner,record.id,{...result,outputTokens:31}),e=>e.status===409);
 await assert.rejects(()=>f.usage.settleAaroUsage(owner,record.id,{state:'failed'}),e=>e.status===409);
});
test('AARO known failure releases once; unclaimed success, missing usage and overspend stay held',async()=>{
 const f=fixture(),{record}=await f.reserve();await assert.rejects(()=>f.usage.settleAaroUsage(owner,record.id,{state:'succeeded',inputTokens:1,outputTokens:1}),e=>e.status===409);
 await f.usage.claimAaroUsage(owner,record.id);
 await assert.rejects(()=>f.usage.settleAaroUsage(owner,record.id,{state:'succeeded'}),e=>e.status===400);
 await assert.rejects(()=>f.usage.settleAaroUsage(owner,record.id,{state:'succeeded',inputTokens:1,outputTokens:150}),e=>e.status===409);
 assert.equal((await f.usage.aaroUsageTotals(owner)).reserved,600);
 f.env.AARO_USAGE_ENABLED='false';await f.usage.settleAaroUsage(owner,record.id,{state:'failed'});await f.usage.settleAaroUsage(owner,record.id,{state:'failed'});
 assert.equal((await f.usage.aaroUsageTotals(owner)).available,1000);
});
test('AARO ambiguous completion retains credits until trusted reconciliation; risk hold blocks only new work',async()=>{
 const f=fixture(),{record}=await f.reserve();await f.usage.claimAaroUsage(owner,record.id);await f.usage.uncertainAaroUsage(owner,record.id);
 assert.equal((await f.usage.aaroUsageTotals(owner)).reserved,600);await assert.rejects(()=>f.reserve('request-2222'),e=>e.status===402);
 await f.usage.settleAaroUsage(owner,record.id,{state:'succeeded',inputTokens:10,outputTokens:10});assert.equal((await f.usage.aaroUsageTotals(owner)).available,950);
 const g=fixture(),row=await g.reserve();await g.usage.claimAaroUsage(owner,row.record.id);g.sql.prepare('INSERT INTO aaro_payment_holds VALUES(?,?,?)').run('in_fixture','refund-review',new Date().toISOString());await g.usage.settleAaroUsage(owner,row.record.id,{state:'succeeded',inputTokens:10,outputTokens:10});assert.equal((await g.usage.aaroUsageTotals(owner)).available,0);
});
test('AARO maintenance releases only never-dispatched work and retains crashed execution',async()=>{
 const f=fixture(3000),first=await f.reserve('request-1111'),second=await f.reserve('request-2222');await f.usage.claimAaroUsage(owner,second.record.id);
 f.sql.prepare("UPDATE aaro_usage_requests SET expires_at='2020-01-01T00:00:00.000Z',updated_at='2020-01-01T00:00:00.000Z'").run();
 await f.usage.maintainAaroUsage();assert.equal(f.sql.prepare('SELECT state FROM aaro_usage_requests WHERE id=?').get(first.record.id).state,'cancelled');assert.equal(f.sql.prepare('SELECT state FROM aaro_usage_requests WHERE id=?').get(second.record.id).state,'uncertain');assert.equal((await f.usage.aaroUsageTotals(owner)).reserved,600);
 assert.equal(await f.usage.claimAaroUsage(owner,first.record.id),null);
});
