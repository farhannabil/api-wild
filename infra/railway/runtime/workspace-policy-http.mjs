import {SUPABASE_ORIGIN} from './supabase-gateway-rpc.mjs';
import {createWorkspacePolicy} from './workspace-policy.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=status=>{throw Object.assign(new Error('Workspace unavailable.'),{status})};
async function json(response){if(!response.ok||response.redirected||!/^application\/json/.test(response.headers.get('content-type')||''))fail(503);const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const item=await reader.read();if(item.done)break;if((size+=item.value.length)>16384)fail(503);chunks.push(item.value)}return JSON.parse(Buffer.concat(chunks).toString('utf8'))}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}}
function send(res,status,data){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data))}
export function createWorkspacePolicyHttpFromEnv(env,{fetchImpl=fetch}={}){
 const secret=env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY,mode=env.BILLING_MODE||'live';
 const enabled=env.OWN_WORKSPACE_ENABLED==='true'&&Boolean(secret)&&['live','test'].includes(mode);
 const rpc=async(name,params)=>json(await fetchImpl(SUPABASE_ORIGIN+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:secret,...(secret.startsWith('sb_secret_')?{}:{authorization:'Bearer '+secret}),'content-type':'application/json'},body:JSON.stringify(params),redirect:'error',signal:AbortSignal.timeout(10000)}));
 const policy=createWorkspacePolicy({rpc,verifyOwner:async({authorization})=>{
  if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(authorization))fail(401);
  const response=await fetchImpl(SUPABASE_ORIGIN+'/auth/v1/user',{headers:{apikey:env.SUPABASE_ANON_KEY||secret,authorization},redirect:'error',signal:AbortSignal.timeout(10000)});
  if([401,403].includes(response.status)){await response.body?.cancel().catch(()=>{});fail(401)}
  const user=await json(response);if(!uuid.test(user.id)||!user.email_confirmed_at||user.is_anonymous!==false)fail(401);
  const initialized=await rpc('apiwild_gateway_account_initialize',{p_owner:mode+':supabase:'+user.id});if(initialized.initialized!==true||initialized.customer_id!==user.id||initialized.billing_mode!==mode)fail(503);
  return {customerId:user.id,billingMode:mode};
 }});
 return Object.freeze({matches:path=>path.split('?')[0]==='/api/workspace',async handle(req,res){try{
  if(!enabled)fail(503);if(req.url!=='/api/workspace')fail(400);if(!['GET','PATCH'].includes(req.method))fail(405);
  if(Object.keys(req.headers).some(k=>k.startsWith('oai-authenticated-')))fail(403);
  if(req.method==='GET')return send(res,200,await policy.read(req.headers.authorization));
  if(req.headers.origin!=='https://apiwild.com')fail(403);
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415);
  let size=0;const chunks=[],timer=setTimeout(()=>req.destroy(),5000);let input;
  try{for await(const chunk of req){if((size+=chunk.length)>4096)fail(413);chunks.push(chunk)}try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail(400)}}finally{clearTimeout(timer)}
  try{return send(res,200,await policy.update(req.headers.authorization,input))}catch(e){if(e.message==='workspace_invalid_policy'||e.code==='gateway_invalid_object')fail(400);throw e}
 }catch(e){send(res,[400,401,403,405,413,415].includes(e.status)?e.status:503,{error:'Workspace settings unavailable.'})}}});
}
