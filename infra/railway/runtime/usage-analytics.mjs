// Native receipt facts stay immutable. This optional metadata is never money.
export function gatewayTokenDetails(usage){
 const out={};for(const [key,value] of [['cache_read_tokens',usage?.prompt_tokens_details?.cached_tokens??usage?.cache_read_input_tokens],['cache_write_tokens',usage?.cache_creation_input_tokens]])if(Number.isSafeInteger(value)&&value>=0&&value<=1000000000)out[key]=value;
 return out;
}
export function nativeTokenDetails(row,fact){
 const other=typeof row.other==='string'?JSON.parse(row.other):row.other;
 const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000000?v:null;
 const read=count(other?.cache_tokens),total=count(other?.cache_creation_tokens??other?.cache_write_tokens);
 const short=count(other?.cache_creation_tokens_5m),long=count(other?.cache_creation_tokens_1h);
 return {fact,cacheReadTokens:read,cacheWriteTokens:total??(short!==null&&long!==null?count(short+long):null)};
}
export function validateUsageDashboard(v){
 const fields=['requests','inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','cacheReadKnown','cacheWriteKnown','chargedUsdMicros','pendingRequests'];
 const counts=r=>r&&fields.every(k=>Number.isSafeInteger(r[k])&&r[k]>=0)&&r.cacheReadKnown<=r.requests&&r.cacheWriteKnown<=r.requests;
 const stamp=t=>t===null||(typeof t==='string'&&Number.isFinite(Date.parse(t)));
 if(v?.currency!=='USD'||v.windowDays!==30||v.timezone!=='UTC'||!counts(v.totals)||!stamp(v.refreshedAt)||!Array.isArray(v.days)||v.days.length>30||!v.days.every(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.day)&&counts(r))||!Array.isArray(v.models)||v.models.length>100||!v.models.every(r=>typeof r.model==='string'&&r.model.length<=200&&Number.isSafeInteger(r.requests)&&r.requests>=0&&Number.isSafeInteger(r.chargedUsdMicros)&&r.chargedUsdMicros>=0)||!(v.billingCheck===null||(stamp(v.billingCheck.checkedAt)&&['mismatches','overdueRequests','staleKeys'].every(k=>Number.isSafeInteger(v.billingCheck[k])&&v.billingCheck[k]>=0))))throw Error('usage_dashboard_unverified');
 return v;
}
