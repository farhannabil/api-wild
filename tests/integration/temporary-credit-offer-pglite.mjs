// Synthetic isolated SQL acceptance only. No remote database, Stripe or supplier.
import {pathToFileURL,fileURLToPath} from 'node:url';import fs from 'node:fs';import assert from 'node:assert/strict';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href),root=fileURLToPath(new URL('../../',import.meta.url));
const db=new PGlite(),account='acct_1UCiHk0SGcPsf6AA',customer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='test:supabase:'+customer;
let count=0;const eq=(a,b)=>{assert.deepEqual(a,b);count++;},reject=async(operation,pattern)=>{await assert.rejects(operation,pattern);count++;};
const query=async(sql,args=[])=>(await db.query(sql,args)).rows[0],uuid=n=>'bbbbbbbb-bbbb-4bbb-8bbb-'+String(n).padStart(12,'0');
await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean default false);create function auth.uid() returns uuid language sql as $$select null::uuid$$;create table public.customer_profiles(user_id uuid primary key,onboarding_completed_at timestamptz);`);
for(const name of ['20261003060000_apiwild_gateway_portability.sql','20261005010000_apiwild_stripe_projection.sql','20261005010100_apiwild_stripe_checkout.sql','20261005030000_retail_supplier_separation.sql','20261005083727_supplier_allowance_outbox.sql','20261005180000_credit_package_promotion.sql'])await db.exec(fs.readFileSync(root+'supabase/migrations/'+name,'utf8'));
await db.query('insert into auth.users values($1,now(),false)',[customer]);await db.query('select apiwild_gateway_account_initialize($1)',[owner]);
const prepare=async(n,{who=owner,price='price_dollar',pkg='launch-dollar',amount=100,start=null,end=null}={})=>(await query('select apiwild_stripe_prepare_checkout($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[uuid(n),who,'test',account,price,pkg,amount,start,end])).r;
const register=async(q,{who=owner,session='cs_test_'+q.order_id.replaceAll('-','')}={})=>(await query('select apiwild_stripe_register_checkout($1,$2,$3,$4,$5,$6,$7) r',[q.order_id,who,'test',account,session,'cus_fixture',q.amount_cents])).r;
const balance=async()=>(await query('select apiwild_billing_read($1) r',[owner])).r;
let event=0;const project=async(q,operation,changes={},eventId)=>{
 const base={order_id:q.order_id,customer_id:'cus_fixture',currency:'usd',payment_intent:'pi_'+q.order_id.replaceAll('-','')};
 const fact=operation==='checkout'?{...base,session_id:'cs_test_'+q.order_id.replaceAll('-',''),subtotal_cents:q.amount_cents,total_cents:q.amount_cents,tax_cents:0,discount_cents:0,status:'complete',payment_status:'paid',...changes}:{...base,received_cents:q.amount_cents,refunded_cents:q.amount_cents,...changes};
 return(await query('select apiwild_stripe_project($1,$2,$3,$4,$5,$6,$7,$8) r',[account,'test',eventId??'evt_fixture'+(++event),operation==='checkout'?'checkout.session.completed':'charge.refunded','a'.repeat(64),100+event,operation,JSON.stringify(fact)])).r;
};
// Preserve a pre-migration genuine ledger shape; migration must not alter funds.
const previous=await prepare(1,{pkg:null,amount:3000,price:'price_standard'});await register(previous);await project(previous,'checkout');eq((await balance()).balanceCents,3000);
const priorEntries=(await db.query('select * from apiwild_finance.stripe_credit_entries order by source_id')).rows;
await db.exec(fs.readFileSync(root+'supabase/migrations/20261006002100_temporary_dollar_credit_offer.sql','utf8'));
eq((await balance()).balanceCents,3000);eq((await db.query('select * from apiwild_finance.stripe_credit_entries order by source_id')).rows,priorEntries);
await reject(prepare(2),/temporary_offer_unavailable/);
const expires=new Date(Date.now()+12*3600000).toISOString();
eq((await query('select apiwild_temporary_credit_offer_enroll($1,$2,$3) r',[owner,'price_dollar',expires])).r.enrolled,true);
eq((await balance()).balanceCents,3000);eq((await query('select apiwild_temporary_credit_offer_read($1) r',[owner])).r.eligible,true);
await reject(db.query('select apiwild_temporary_credit_offer_enroll($1,$2,$3)',[owner,'price_other',expires]),/temporary_offer_immutable/);
await reject(db.query('select apiwild_temporary_credit_offer_enroll($1,$2,$3)',[owner,'price_dollar',new Date(Date.now()+25*3600000).toISOString()]),/temporary_offer_immutable/);
await reject(db.query('select apiwild_temporary_credit_offer_enroll($1,$2,$3)',[owner,'price_dollar',new Date(Date.now()-1000).toISOString()]),/temporary_offer_immutable/);
const otherCustomer='dddddddd-dddd-4ddd-8ddd-dddddddddddd',otherOwner='test:supabase:'+otherCustomer;
await db.query('insert into auth.users values($1,now(),false)',[otherCustomer]);await db.query('select apiwild_gateway_account_initialize($1)',[otherOwner]);
for(const end of [Date.now()+25*3600000,Date.now()-1000,Date.now()+30*60000])await reject(db.query('select apiwild_temporary_credit_offer_enroll($1,$2,$3)',[otherOwner,'price_dollar',new Date(end).toISOString()]),/temporary_offer_invalid/);
await reject(prepare(2,{price:'price_wrong'}),/temporary_offer_unavailable/);await reject(prepare(2,{amount:200}),/temporary_offer_invalid/);
await reject(prepare(2,{who:'test:supabase:cccccccc-cccc-4ccc-8ccc-cccccccccccc'}),/temporary_offer_owner_unavailable/);
await reject(prepare(2,{pkg:null}),/checkout_invalid_amount/);await reject(prepare(2,{pkg:'smart'}),/checkout_invalid_amount/);
const dollar=await prepare(2);eq([dollar.package_id,dollar.amount_cents,dollar.bonus_cents,dollar.credit_cents],['launch-dollar',100,0,100]);eq(await prepare(2),dollar);
await reject(prepare(3),/temporary_offer_already_used/);eq((await balance()).balanceCents,3000);
await reject(register({...dollar,order_id:uuid(3)}),/temporary_offer_intent_conflict/);
await register(dollar);await register(dollar);eq((await balance()).balanceCents,3000);
await reject(db.query('update apiwild_finance.stripe_orders set amount_cents=200 where id=$1',[dollar.order_id]),/checkout_terms_immutable/);
await reject(db.query('insert into apiwild_finance.stripe_checkout_intents(order_id,user_id,billing_mode,account_id,price_id,package_id,amount_cents,expires_at) values($1,$2,$3,$4,$5,null,100,clock_timestamp()+interval \'1 hour\')',[uuid(90),owner,'test',account,'price_dollar']),/stripe_intents_bound_amount/);
await reject(db.query('insert into apiwild_finance.stripe_orders(id,user_id,billing_mode,account_id,session_id,stripe_customer_id,amount_cents) values($1,$2,$3,$4,$5,$6,100)',[uuid(91),owner,'test',account,'cs_test_nullpackage','cus_fixture']),/stripe_orders_bound_amount/);
// Simulate passage of time solely in the isolated fixture, retaining registered terms.
await db.exec("update apiwild_finance.temporary_credit_offers set created_at=clock_timestamp()-interval '2 hours',ends_at=clock_timestamp()-interval '1 second'; update apiwild_finance.stripe_checkout_intents set expires_at=clock_timestamp()-interval '2 seconds' where package_id='launch-dollar';");
eq((await query('select apiwild_temporary_credit_offer_read($1) r',[owner])).r.eligible,false);await reject(prepare(2),/temporary_offer_unavailable/);
const expiredEnrollment=await query('select ends_at from apiwild_finance.temporary_credit_offers where user_id=$1',[owner]);
eq((await query('select apiwild_temporary_credit_offer_enroll($1,$2,$3) r',[owner,'price_dollar',expiredEnrollment.ends_at])).r.enrolled,true);
await register(dollar);await project(dollar,'checkout',{},'evt_dollarpaid');eq((await balance()).balanceCents,3100);
eq((await project(dollar,'checkout',{},'evt_dollarpaid')).replayed,true);await project(dollar,'checkout');eq((await balance()).balanceCents,3100);
const history=(await balance()).orders.find(order=>order.id===dollar.order_id);eq([history.amount_cents,history.bonus_cents,history.credit_cents,history.package_id],[100,0,100,'launch-dollar']);
await project(dollar,'refund');eq((await balance()).balanceCents,3000);await project(dollar,'refund');await project(dollar,'checkout');eq((await balance()).balanceCents,3000);
await reject(prepare(3),/temporary_offer_unavailable/);
// Standard custom topups and four promotional packages retain established policy.
const now=Date.now(),start=new Date(now-60000).toISOString(),end=new Date(now-60000+15*86400000+31*60000).toISOString();
for(const [index,pkg,amount,bonus]of [[4,'smart',7700,1300],[5,'nerd',10100,1900],[6,'newton',23400,2600],[7,'alien',34500,5500]]){
 const q=await prepare(index,{pkg,amount,price:'price_'+pkg,start,end});eq([q.amount_cents,q.bonus_cents,q.credit_cents],[amount,bonus,amount+bonus]);await register(q);
}
const standard=await prepare(8,{pkg:null,amount:3000,price:'price_standard'});await register(standard);eq(standard.bonus_cents,0);await reject(prepare(9,{pkg:null,amount:2900}),/checkout_invalid_amount/);
eq((await query("select has_function_privilege('anon','public.apiwild_temporary_credit_offer_enroll(text,text,timestamptz)','execute') a,has_function_privilege('authenticated','public.apiwild_temporary_credit_offer_read(text)','execute') b,has_function_privilege('service_role','public.apiwild_temporary_credit_offer_enroll(text,text,timestamptz)','execute') c,has_table_privilege('service_role','apiwild_finance.temporary_credit_offers','insert') d,has_function_privilege('service_role','apiwild_finance.stripe_prepare_standard_v1(uuid,text,text,text,text,text,bigint,timestamptz,timestamptz)','execute') e")),{a:false,b:false,c:true,d:false,e:false});
await db.close();console.log('PASS: '+count+' synthetic SQL assertions; owner/price/expiry/one-order binding,100-cent constraint, late exactly-once paid projection/refund and existing standard packages preserved');
