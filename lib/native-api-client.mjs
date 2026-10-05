// Browser BFF client. Customer sessions remain in Secure HttpOnly cookies.
const errors={native_auth_disabled:'API account access is awaiting activation.',native_customer_disabled:'API account access is awaiting activation.',native_key_writes_disabled:'API key creation is awaiting activation.',native_key_write_disabled:'API key changes are awaiting activation.',native_billing_disabled:'Billing access is awaiting activation.',native_invalid_origin:'API account access is available on apiwild.com after activation.',native_session_required:'Please sign in to your API account.',native_session_expired:'Your API session expired. Please sign in again.',native_auth_rejected:'Your sign-in or registration could not be completed. Check your details and retry.',native_rate_limited:'Too many requests. Please wait before trying again.',native_checkout_disabled:'Credit purchases are not activated.',native_checkout_not_configured:'Credit purchases are not configured yet.',native_invalid_request:'Check the information entered and try again.'};
export class NativeApiError extends Error{constructor(code,status=503){super(errors[code]??'The API account service could not complete this request. Please retry.');this.code=code;this.status=status;}}
/** @param {string} path @param {{method?: string, body?: unknown, signal?: AbortSignal, fetchImpl?: typeof fetch}} options */
export async function nativeApi(path,{method='GET',body,signal,fetchImpl=fetch}={}){
 if(typeof path!=='string'||!/^\/api\/native\/(?:auth\/(?:self|login|register|logout)|customer\/(?:account|usage|keys(?:\/\d+)?|logs|logStats|billing\/(?:info|history|checkout)))$/.test(path))throw new NativeApiError('native_invalid_request',400);
 if(!['GET','POST','DELETE'].includes(method))throw new NativeApiError('native_invalid_request',400);
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
 try{
  const response=await fetchImpl(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{accept:'application/json',...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw new NativeApiError('native_invalid_response');
  const raw=await response.text();if(raw.length>600000)throw new NativeApiError('native_invalid_response');let data;try{data=JSON.parse(raw)}catch{throw new NativeApiError('native_invalid_response')}
  if(!response.ok||!data||data.success!==true)throw new NativeApiError(typeof data?.error==='string'?data.error:'native_request_failed',response.status);
  return data;
 }catch(error){if(error instanceof NativeApiError)throw error;throw new NativeApiError('native_request_failed')}
 finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort)}
}
