export const WALLET_UPDATED_EVENT:string;
export function watchWallet<T>(options:{read:(signal:AbortSignal)=>Promise<T>;onValue:(value:T)=>void;onError:(error:unknown)=>void;document:Document;window:Window;intervalMs?:number}):()=>void;
