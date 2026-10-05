import {pinSupplierConversion} from '../runtime/subrouter-supplier-conversion.mjs';
export const status={quota_per_unit:500000,quota_display_type:'CNY',display_in_currency:true,price:6.8,usd_exchange_rate:6.8};
export const conversion=pinSupplierConversion({status,observedAt:'2026-10-05T00:00:00Z',validUntil:'2026-11-04T00:00:00Z'});
export const receiptNow=Date.parse('2026-10-05T12:00:00Z');
