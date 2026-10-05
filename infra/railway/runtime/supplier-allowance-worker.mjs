// Private, explicitly invoked worker. Durable authority is the SQL outbox, never
// a payment-success URL or a caller-provided paid flag. No scheduler is started.
import {createHash} from 'node:crypto';
import {strictObject, exactInteger, withDeadline} from './supabase-gateway-rpc.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER = /^(live|test):supabase:[0-9a-f-]{36}$/;
const fail = code => Object.assign(new Error(code), {code});
const held = () => Object.freeze({activated:false, status:'awaiting-reconciliation', automaticRetry:false});
function reference(raw) {
  strictObject(raw,['owner','orderId']);
  if (!OWNER.test(raw.owner) || !UUID.test(raw.owner.split(':')[2]) || !UUID.test(raw.orderId)) throw fail('allowance_invalid_reference');
  return Object.freeze({...raw});
}
function claimRecord(value, ref) {
  strictObject(value,['order_id','user_id','state','version','native_user_id','package_id','expected_quota','code_reference','code_sha256']);
  if (value.order_id !== ref.orderId || value.user_id !== ref.owner || value.state !== 'executing'
      || !UUID.test(value.code_reference) || !/^[a-f0-9]{64}$/.test(value.code_sha256)) throw fail('allowance_unverified_claim');
  exactInteger(value.version,1); exactInteger(value.native_user_id,1,2147483647);
  exactInteger(value.package_id,1,2147483647); exactInteger(value.expected_quota,1);
  return Object.freeze({...value});
}
export function createSupplierAllowanceWorker({enabled=false, rpc, resolveCode, activate, timeoutMs=15000}={}) {
  if (enabled !== true) return Object.freeze({run:async () => { throw fail('allowance_worker_disabled'); }});
  if (typeof rpc !== 'function' || typeof resolveCode !== 'function' || typeof activate !== 'function') throw fail('allowance_worker_unconfigured');
  exactInteger(timeoutMs,1,30000);
  return Object.freeze({async run(raw) {
    const ref = reference(raw); let record;
    try {
      return await withDeadline(async signal => {
        const claimed = await rpc('apiwild_allowance_claim',{p_owner:ref.owner,p_order:ref.orderId},{signal});
        if (signal.aborted) return held();
        if (claimed?.claimed !== true) return held(); // Replays never call the station again.
        record = claimRecord(claimed.record,ref);
        const code = await resolveCode(record.code_reference,{signal});
        if (signal.aborted) return held();
        if (typeof code !== 'string' || !/^[A-Za-z0-9-]{4,128}$/.test(code)
            || createHash('sha256').update(code).digest('hex') !== record.code_sha256) throw fail('allowance_code_unverified');
        // Recheck after secret resolution. Refund/dispute/expired claim wins before dispatch.
        const authorized = await rpc('apiwild_allowance_dispatch_guard',{
          p_owner:ref.owner,p_order:ref.orderId,p_version:record.version},{signal});
        if (signal.aborted || authorized?.dispatch !== true) return held();
        const receipt = await activate({userId:record.native_user_id,packageId:record.package_id,code,
          orderId:record.order_id,expectedQuota:record.expected_quota});
        if (signal.aborted) return held();
        strictObject(receipt,['orderId','userId','packageId','quotaRedeemed','alreadyActivated']);
        if (receipt.orderId !== ref.orderId || receipt.userId !== record.native_user_id || receipt.packageId !== record.package_id
            || receipt.quotaRedeemed !== record.expected_quota || typeof receipt.alreadyActivated !== 'boolean') throw fail('allowance_receipt_mismatch');
        const final = await rpc('apiwild_allowance_finish',{p_owner:ref.owner,p_order:ref.orderId,p_version:record.version,
          p_receipt:{order_id:receipt.orderId,user_id:receipt.userId,package_id:receipt.packageId,
            quota_redeemed:receipt.quotaRedeemed,already_activated:receipt.alreadyActivated}},{signal});
        return final?.activated === true ? Object.freeze({activated:true,status:'activated',automaticRetry:false}) : held();
      },timeoutMs);
    } catch {
      // No automatic release or redispatch after a lost claim/activation/finish response.
      if (record) { try { await withDeadline(signal => rpc('apiwild_allowance_uncertain',{
        p_owner:ref.owner,p_order:ref.orderId,p_version:record.version},{signal}),3000); } catch {} }
      return held();
    }
  }});
}
