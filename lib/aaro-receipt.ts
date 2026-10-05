import {RequestError} from '@/db/service';

// The bridge and this short-lived receipt settle already-authorized work even if
// the customer's access token expires while the provider is answering.
type Receipt={id:string;owner:string;expires:number;signature:string};
const payload=(r:Omit<Receipt,'signature'>)=>JSON.stringify([r.id,r.owner,r.expires]);
async function signature(secret:string,r:Omit<Receipt,'signature'>){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(payload(r)))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function issueAaroReceipt(secret:string,id:string,owner:string):Promise<Receipt>{
 const r={id,owner,expires:Math.floor(Date.now()/1000)+600};return {...r,signature:await signature(secret,r)};
}
export async function verifyAaroReceipt(secret:string,receipt:any,id:string){
 const now=Math.floor(Date.now()/1000);
 if(!receipt||typeof receipt!=='object'||receipt.id!==id||typeof receipt.owner!=='string'||!/^(live|test):supabase:[A-Za-z0-9-]+$/.test(receipt.owner)||!Number.isSafeInteger(receipt.expires)||receipt.expires<now||receipt.expires>now+600||typeof receipt.signature!=='string'||!/^[a-f0-9]{64}$/.test(receipt.signature))throw new RequestError('Invalid or expired settlement receipt.',401);
 const expected=await signature(secret,receipt);let diff=0;for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^receipt.signature.charCodeAt(i);
 if(diff)throw new RequestError('Invalid settlement receipt.',401);return receipt.owner as string;
}
