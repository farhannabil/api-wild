import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const SUPPORT = 'support@apiwild.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});

// Svix specification: raw bytes, timestamp tolerance, versioned signatures,
// decoded whsec_ key and constant-time comparison. No parsed-body reserialization.
export function verifyWebhook(raw,headers,secret,now=Date.now()) {
  const id=headers.get('svix-id'), ts=headers.get('svix-timestamp'), sig=headers.get('svix-signature');
  if (!id || id.length>256 || !/^\d{1,12}$/.test(ts||'') || Math.abs(now/1000-Number(ts))>300 || !secret?.startsWith('whsec_')) throw Error('invalid_signature');
  const key=Buffer.from(secret.slice(6),'base64');
  if (key.length<16) throw Error('invalid_signature');
  const expected=createHmac('sha256',key).update(`${id}.${ts}.${raw}`).digest();
  const valid=(sig||'').split(' ').some(part=>{
    if (!part.startsWith('v1,')) return false;
    const value=Buffer.from(part.slice(3),'base64');
    return value.length===expected.length && timingSafeEqual(value,expected);
  });
  if (!valid) throw Error('invalid_signature');
  return JSON.parse(raw);
}

export function address(value) {
  if (typeof value!=='string' || /[\r\n]/.test(value)) return null;
  const s=value.trim(), match=s.match(/^(?:[^<>]*<([^<>]+)>|([^<>]+))$/);
  const mail=(match?.[1]||match?.[2]||'').trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(mail) && mail.length<=254 ? mail : null;
}
const hasSupport = xs => Array.isArray(xs) && xs.some(x=>address(x)===SUPPORT);

export function replyPolicy(email) {
  const sender=address(email.from);
  const headers=Object.fromEntries(Object.entries(email.headers||{}).map(([k,v])=>[k.toLowerCase(),String(v).trim()]));
  let reason=null;
  if (!hasSupport(email.to)) reason='other_recipient';
  else if (!sender) reason='invalid_sender';
  else if (sender.endsWith('@apiwild.com')) reason='own_sender';
  else if (/^(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon|postmaster)(?:[+@._-]|$)/i.test(sender)) reason='automated_sender';
  else if (headers['auto-submitted'] && headers['auto-submitted'].toLowerCase()!=='no') reason='auto_submitted';
  else if (headers['x-auto-response-suppress'] || headers['list-id'] || /bulk|list|junk/i.test(headers.precedence||'')) reason='bulk_message';
  else if (Object.hasOwn(headers,'return-path') && (!headers['return-path'] || headers['return-path']==='<>')) reason='empty_return_path';
  else if (headers['in-reply-to'] || headers.references) reason='followup_message';
  return {sender,reason};
}

const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function buildReply(email,sender,template) {
  const ticket='AW-'+email.id.slice(0,8).toUpperCase();
  const subject=String(email.subject||'(No subject)').replace(/[\r\n\x00-\x1f]/g,' ').slice(0,160);
  const headers={'Auto-Submitted':'auto-replied','X-Auto-Response-Suppress':'All'};
  if (/^<[^<>\r\n ]{1,240}>$/.test(email.message_id||'')) {
    headers['In-Reply-To']=email.message_id;
    headers.References=email.message_id;
  }
  return {from:'API WILD Support <support@apiwild.com>',to:[sender],reply_to:SUPPORT,
    subject:`We received your API WILD message [${ticket}]`,
    html:template.replaceAll('{{ticket_id}}',ticket).replaceAll('{{ticket_subject}}',escape(subject)),
    text:`API WILD Support\n\nWe received your message.\nRequest: ${ticket}\nSubject: ${subject}\n\nYour support request has been recorded. Reply to this email to add information.\nPlease do not send passwords, API keys, payment card details, or private customer data.\n\nhttps://apiwild.com\nsupport@apiwild.com`,headers};
}

async function readWebhookBody(request,limit) {
  const reader=request.body?.getReader();
  if (!reader) return '';
  const decoder=new TextDecoder();
  let raw='',bytes=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      bytes+=value.byteLength;
      if (bytes>limit) {
        await reader.cancel().catch(()=>{});
        return null;
      }
      raw+=decoder.decode(value,{stream:true});
    }
    return raw+decoder.decode();
  } finally { reader.releaseLock(); }
}

export function createHandler({secret,enabled,db,provider,template,now=Date.now}) {
  return async request=>{
    if (request.method==='GET' && new URL(request.url).pathname.endsWith('/health')) {
      try { if (!enabled || !secret || !await db.healthy()) return json({status:'unavailable'},503); return json({status:'ok',service:'apiwild-support',version:1}); }
      catch { return json({status:'unavailable'},503); }
    }
    if (request.method!=='POST') return json({error:'method_not_allowed'},405);
    if (Number(request.headers.get('content-length')||0)>65536) return json({error:'too_large'},413);
    let raw;
    try { raw=await readWebhookBody(request,65536); }
    catch { return json({error:'invalid_body'},400); }
    if (raw===null) return json({error:'too_large'},413);
    let event;
    try {event=verifyWebhook(raw,request.headers,secret,now());} catch {return json({error:'invalid_signature'},401);}
    if (event.type!=='email.received') return json({status:'ignored'});
    if (!enabled) return json({error:'temporarily_unavailable'},503);
    if (!UUID.test(event.data?.email_id||'')) return json({error:'invalid_event'},400);
    if (!hasSupport(event.data?.to)) return json({status:'ignored'});
    try {
      const email=await provider.receive(event.data.email_id);
      if (email.id!==event.data.email_id) throw Error('received_id_mismatch');
      const {sender,reason}=replyPolicy(email);
      const hash=createHash('sha256').update(sender||'invalid').digest('hex');
      const claim=await db.claim(email.id,hash,reason?null:buildReply(email,sender,template),reason);
      if (claim.action==='busy') return json({error:'retry_later'},503);
      if (claim.action==='done') return json({status:'recorded'});
      if (claim.action!=='send' || !claim.payload) throw Error('invalid_claim');
      const result=await provider.send(claim.payload,`apiwild-support/${email.id}`);
      if (!UUID.test(result.id||'')) throw Error('invalid_send_response');
      if (!await db.complete(email.id,claim.lease_id,result.id)) throw Error('completion_not_recorded');
      return json({status:'acknowledged'});
    } catch {
      // Provider retries the signed event. Do not log raw mail, addresses or secrets.
      return json({error:'temporarily_unavailable'},503);
    }
  };
}
