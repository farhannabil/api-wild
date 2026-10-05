'use client';
import {useEffect,useState} from 'react';
import {customerApi} from '@/lib/customer-api';
import {watchWallet} from '@/lib/owned-wallet-poll.mjs';
export type Wallet={currency:'USD';fundedUsdMicros:number;spentUsdMicros:number;reservedUsdMicros:number;paymentHoldUsdMicros:number;availableUsdMicros:number;completedRequests:number};
export const walletMoney=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6}).format(n/1e6);
export function useOwnedWallet(retry=0){
 const[data,setData]=useState<Wallet|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{setLoading(true);return watchWallet({document,window,read:async signal=>{
  const value=await customerApi('/api/usage',{signal});
  if(value.currency!=='USD'||['fundedUsdMicros','spentUsdMicros','reservedUsdMicros','paymentHoldUsdMicros','availableUsdMicros','completedRequests'].some(key=>!Number.isSafeInteger(value[key])||value[key]<0))throw Error('Usage information could not be verified.');
  return value as Wallet;
 },onValue:value=>{setData(value);setError('');setLoading(false)},onError:()=>{setError('Balance could not refresh. Displayed amounts may be out of date.');setLoading(false)}})},[retry]);
 return {data,error,loading};
}
