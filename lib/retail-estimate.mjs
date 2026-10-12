// Public retail calculation only; no supplier data or finance mutations.
export function retailEstimate(inputRate,outputRate,inputTokens,outputTokens){
 const rates=[inputRate,outputRate].map(n=>{
  if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>10000||Math.abs(Number(n.toFixed(6))-n)>1e-10)throw Error('Invalid rate');
  return BigInt(n.toFixed(6).replace('.',''));
 });
 for(const n of [inputTokens,outputTokens])if(!Number.isSafeInteger(n)||n<0||n>1000000000)throw Error('Invalid token count');
 const micros=(rates[0]*BigInt(inputTokens)+rates[1]*BigInt(outputTokens)+BigInt(999999))/BigInt(1000000);
 return Number(micros)/1000000;
}
