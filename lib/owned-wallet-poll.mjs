// Refresh only while visible, serialize reads, and ignore responses after unmount.
export const WALLET_UPDATED_EVENT='apiwild:wallet-updated';
export function watchWallet({read,onValue,onError,document:doc,window:win,intervalMs=3000}){
 let stopped=false,running=false,again=false,timer=null;const controller=new AbortController();
 const clear=()=>{if(timer!==null){win.clearTimeout(timer);timer=null;}};
 async function refresh(){
  clear();if(stopped||doc.hidden)return;if(running){again=true;return;}running=true;
  try{const value=await read(AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));if(!stopped)onValue(value);}catch(error){if(!stopped)onError(error);}
  finally{running=false;if(!stopped){if(again){again=false;void refresh();}else if(!doc.hidden)timer=win.setTimeout(refresh,intervalMs);}}
 }
 const visibility=()=>{if(doc.hidden)clear();else void refresh();};
 doc.addEventListener('visibilitychange',visibility);win.addEventListener('focus',refresh);win.addEventListener(WALLET_UPDATED_EVENT,refresh);void refresh();
 return ()=>{stopped=true;clear();controller.abort();doc.removeEventListener('visibilitychange',visibility);win.removeEventListener('focus',refresh);win.removeEventListener(WALLET_UPDATED_EVENT,refresh);};
}
