import {supabaseBrowser} from '@/lib/supabase-browser';
export async function customerApi(path:string,options:RequestInit={}){
 const client=await supabaseBrowser(),{data:{session}}=await client.auth.getSession();
 if(!session)throw Error('Your session expired. Sign in again.');
 const response=await fetch(path,{...options,headers:{Authorization:'Bearer '+session.access_token,...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},cache:'no-store',signal:options.signal||AbortSignal.timeout(180000)});
 const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'The request could not be completed.'),{data,status:response.status});return data;
}
