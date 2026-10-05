export function keyLimitMicros(amount,noLimit){
 if(noLimit===true)return null;
 const value=Number(amount),micros=Math.round(value*1e6);
 if(!String(amount).trim()||!Number.isFinite(value)||value<=0||!Number.isSafeInteger(micros)||Math.abs(value*1e6-micros)>0.0001)throw Error('Enter a positive key spending limit, or choose no key limit.');
 return micros;
}
export function keyExpiry(days,now=Date.now()){
 if(days==='never')return null;
 if(!['7','30','90'].includes(days))throw Error('Choose an expiry option.');
 return new Date(now+Number(days)*86400000).toISOString();
}
