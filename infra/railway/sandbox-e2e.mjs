// Local, interactive acceptance only. Importing this file does not start work.
import {createServer,request} from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import fs from 'node:fs';import path from 'node:path';
import {sandboxConfiguration,createSandboxE2eHarness,SANDBOX_KEY_REFERENCE} from './runtime/sandbox-e2e-harness.mjs';
import {createSubrouterReceiptReader} from './runtime/subrouter-receipt-reader.mjs';
import {createSupplierDebitRpc} from './runtime/supplier-debit-operator.mjs';
import {createSupplierDebitReconciler} from './runtime/supplier-debit-reconciliation.mjs';
const exec=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const DEFAULT_CLI='C:/Users/farha/AppData/Roaming/npm/node_modules/@stripe/cli/node_modules/@stripe/cli-win32-x64/bin/stripe.exe';
const events='checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.expired,checkout.session.async_payment_failed,charge.refunded,refund.created,refund.updated,refund.failed';
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
function cliEnvironment(env){const child={...env};for(const name of Object.keys(child))if(/^(STRIPE_|APIWILD_|SUPABASE_|SUBROUTER_)/.test(name))delete child[name];return child;}
function localCall(port,transportNonce,{authorization,requestKey,body}){
  return new Promise((resolve,reject)=>{
    const bytes=Buffer.from(JSON.stringify(body));const req=request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{host:'apiwild.com',authorization,'x-apiwild-sandbox-transport':transportNonce,'content-type':'application/json','content-length':bytes.length,'idempotency-key':requestKey}},res=>{
      let size=0;const chunks=[];res.on('data',chunk=>{if((size+=chunk.length)>1048576){res.destroy();reject(Error('Local response unavailable.'));}else chunks.push(chunk);});res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(Error('Local response unavailable.'));}});
    });req.setTimeout(40000,()=>req.destroy(Error('Local request unconfirmed.')));req.once('error',reject);req.end(bytes);
  });
}
async function signedBody(req){
  if(req.method!=='POST'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')||typeof req.headers['stripe-signature']!=='string')throw Error();
  req.setTimeout(5000,()=>req.destroy());let size=0;const chunks=[];for await(const chunk of req){if((size+=chunk.length)>1000000)throw Error();chunks.push(chunk);}return Buffer.concat(chunks,size);
}
export function sandboxHttpHandler(harness,transportNonce){
  if(typeof transportNonce!=='string'||!/^[a-f0-9]{64}$/.test(transportNonce))throw Error('Invalid private transport.');
  return async(req,res)=>{
    try{
      if(req.url==='/api/billing/webhook'){
        const result=await harness.webhook(await signedBody(req),req.headers['stripe-signature']);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
      }
      if(req.url==='/v1/chat/completions'){
        if(req.headers['x-apiwild-sandbox-transport']!==transportNonce){res.writeHead(403);res.end();req.resume();return;}
        await harness.gateway.handle(req,res);return;
      }
      if(req.url==='/'&&req.method==='GET'){
        const url=harness.checkoutUrl(),escape=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
        res.end('<!doctype html><title>API WILD sandbox acceptance</title><h1>API WILD sandbox acceptance</h1><p>Sandbox payment only. No live credit purchase.</p>'+(url?'<a href="'+escape(url)+'" rel="noreferrer">Open the registered $30 sandbox checkout</a>':'<p>Waiting for the operator to create the checkout.</p>'));return;
      }
      res.writeHead(404);res.end();
    }catch{if(!res.headersSent&&!res.destroyed){res.writeHead(503,{'content-type':'application/json'});res.end('{"confirmed":false,"automaticRetry":false}');}else res.destroy();}
  };
}
export async function runSandboxE2e({argv=process.argv.slice(2),env=process.env,write=output}={}){
  if(argv.length!==1||!['--check','--serve'].includes(argv[0])){write({usage:'--check | --serve',networkRequests:false});return 3;}
  let config;try{config=sandboxConfiguration(env);}catch{write({configured:false,invalidConfiguration:true,networkRequests:false});return 3;}
  const cliPath=env.APIWILD_STRIPE_CLI_PATH||DEFAULT_CLI;
  if(argv[0]==='--check'){write({configured:config.configured,missing:config.missing??[],executionEnabled:env.APIWILD_SANDBOX_E2E_ENABLED==='true',stripeCliPresent:fs.existsSync(cliPath),databaseAndPaymentVerified:false,networkRequests:false});return config.configured?0:3;}
  if(!config.configured||env.APIWILD_SANDBOX_E2E_ENABLED!=='true'){write({status:'disabled',networkRequests:false});return 3;}
  let fd,server,listener,harness,reader,closed=false;
  try{
    const statePath=env.APIWILD_SANDBOX_RUN_STATE_PATH;
    if(!path.isAbsolute(cliPath)||!fs.statSync(cliPath).isFile()||!path.isAbsolute(statePath??'')||!/^apiwild-sandbox-[A-Za-z0-9_-]+\.jsonl$/.test(path.basename(statePath)))throw Error();
    const actual=path.join(fs.realpathSync(path.dirname(statePath)),path.basename(statePath)),relative=path.relative(fs.realpathSync(root),actual);
    if(!relative.startsWith('..'+path.sep)&&relative!=='..')throw Error();
    fd=fs.openSync(actual,'wx',0o600); // Never resume or replay a previous attempted run.
    const checkpoint=async value=>{fs.writeSync(fd,JSON.stringify({...value,at:new Date().toISOString()})+'\n');fs.fsyncSync(fd);};
    const childEnv=cliEnvironment(env);
    const runStripe=async args=>{
      const {stdout}=await exec(cliPath,args,{env:childEnv,windowsHide:true,timeout:25000,maxBuffer:1048576,encoding:'utf8'});
      return JSON.parse(stdout); // Error bodies and CLI output are never printed.
    };
    const catalog=JSON.parse(fs.readFileSync(new URL('../../data/selected-supplier-models.json',import.meta.url),'utf8'));
    harness=createSandboxE2eHarness({env,catalog,runStripe,checkpoint,write});
    const receiptReader=createSubrouterReceiptReader({enabled:true,accessToken:env.SUBROUTER_ACCOUNT_ACCESS_TOKEN,accountUserId:Number(env.SUBROUTER_ACCOUNT_USER_ID),
      bindings:{[SANDBOX_KEY_REFERENCE]:{tokenId:113333,modelProviders:{[config.route.model]:config.route.supplierSlug}}},conversion:JSON.parse(env.APIWILD_SUPPLIER_CONVERSION_JSON)});
    const debitRpc=createSupplierDebitRpc({secretKey:env.SUPABASE_SECRET_KEY});
    const reconciler=createSupplierDebitReconciler({enabled:true,timeoutMs:30000,rpc:debitRpc,readReceipt:receiptReader.readReceipt,
      readRequest:({owner,requestId},options)=>debitRpc('apiwild_supplier_request_read',{p_owner:owner,p_request:requestId},options)});
    const transportNonce=randomBytes(32).toString('hex');server=createServer(sandboxHttpHandler(harness,transportNonce));
    server.requestTimeout=10000;server.headersTimeout=5000;server.maxConnections=4;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;
    await checkpoint({phase:'serve',state:'started',runId:config.runId,port});
    await new Promise((resolve,reject)=>{
      let carry='',ready=false;const timer=setTimeout(()=>reject(Error()),20000);
      listener=spawn(cliPath,['listen','--events',events,'--forward-to','http://127.0.0.1:'+port+'/api/billing/webhook'],{env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const data=chunk=>{carry+=chunk.toString('utf8');if(carry.length>8192){carry=carry.slice(-8192);}const lines=carry.split(/\r?\n/);carry=lines.pop();for(const line of lines){const match=line.match(/\bwhsec_[A-Za-z0-9]{16,256}\b/);if(match&&!ready){try{harness.setWebhookSecret(match[0]);ready=true;clearTimeout(timer);resolve();}catch{clearTimeout(timer);reject(Error());}}}};
      listener.stdout.on('data',data);listener.stderr.on('data',data);listener.once('error',()=>{clearTimeout(timer);reject(Error());});listener.once('exit',()=>{clearTimeout(timer);if(!ready)reject(Error());else if(!closed){write({status:'listener-stopped',automaticRetry:false});reader?.close();}});
    });
    write({status:'ready',localUrl:'http://127.0.0.1:'+port+'/',commands:['create-checkout','payment-status','run-model','replay','reconcile','refund','refund-status','status','close'],realStripeAndDatabaseNotYetVerified:true});
    reader=createInterface({input:process.stdin,crlfDelay:Infinity});
    const deadline=setTimeout(()=>reader.close(),30*60*1000);
    try{for await(const line of reader){const command=line.trim();try{
      if(command==='status')write(harness.status());
      else if(command==='create-checkout')write(await harness.createCheckout());
      else if(command==='payment-status')write(await harness.paymentStatus());
      else if(command==='run-model')write(await harness.runModel(work=>localCall(port,transportNonce,work)));
      else if(command==='replay')write(await harness.replay(work=>localCall(port,transportNonce,work)));
      else if(command==='reconcile')write(await harness.reconcile(reconciler));
      else if(command==='refund')write(await harness.refund());
      else if(command==='refund-status')write(await harness.refundStatus());
      else if(command==='close')break;
      else write({status:'unknown-command'});
    }catch{write({phase:command,status:'unconfirmed',automaticRetry:false});}}}finally{clearTimeout(deadline);}
    try{write(await harness.close());}catch{write({status:'test-key-revocation-unconfirmed',automaticRetry:false});}
    return 0;
  }catch{write({status:'sandbox-harness-unavailable',automaticRetry:false});return 3;}
  finally{closed=true;reader?.close();listener?.kill();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(fd!==undefined)fs.closeSync(fd);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await runSandboxE2e();
