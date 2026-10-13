import {exactInteger} from './supabase-gateway-rpc.mjs';
export const BILLING_POLICY='supplier-cost-5x-v1';
export function chargeSupplierQuota(quota){
 exactInteger(quota,0,100000000000);
 return {supplierUsdMicros:quota*2,costUsdMicros:quota*10,extraFeeUsdMicros:0,billingPolicy:BILLING_POLICY};
}
// Admission estimate only. Actual customer charges always use original USD quota.
export function supplierCostReserve(cnyMicros){
 exactInteger(cnyMicros,0,1000000000000);
 return Number((BigInt(cnyMicros)*25n+33n)/34n);
}
