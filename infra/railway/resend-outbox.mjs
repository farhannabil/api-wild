// Transactional only. Stripe owns invoice emails; this worker never sends invoices
// or marketing, and does not treat provider acceptance as inbox delivery.
const SUPABASE_ORIGIN = 'https://yautmilnpllojugpmfgy.supabase.co';
const BRANDS = {
  apiwild: {name: 'API WILD', origin: 'https://apiwild.com'},
  aaro: {name: 'AARO', origin: 'https://aaroglobal.com'},
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function welcomeMessage(job) {
  const brand = Object.hasOwn(BRANDS, job.brand_slug) ? BRANDS[job.brand_slug] : null;
  if (!brand || job.template !== 'confirmed-welcome-v1' || !UUID.test(job.id) || !UUID.test(job.lease_id) ||
      typeof job.recipient !== 'string' || job.recipient.length > 254 ||
      /[\u0000-\u001f\u007f]/.test(job.recipient) ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(job.recipient)) {
    throw new Error('unsupported_outbox_record');
  }
  return {
    from: `${brand.name} <support@apiwild.com>`,
    to: [job.recipient],
    subject: `Welcome to ${brand.name}`,
    text: `Welcome to ${brand.name}. Your email is confirmed. Sign in at ${brand.origin} to complete your profile. Paid features are available only after checkout and account acceptance. If you did not create this account, contact support@apiwild.com.`,
    html: `<p>Welcome to ${brand.name}.</p><p>Your email is confirmed. <a href="${brand.origin}">Sign in</a> to complete your profile.</p><p>Paid features are available only after checkout and account acceptance.</p><p>If you did not create this account, contact support@apiwild.com.</p>`,
    tags: [{name: 'brand', value: job.brand_slug}, {name: 'email_type', value: 'confirmed_welcome'}],
  };
}

function cancelReceipt(reader) { try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} }

// One absolute deadline covers transport and the receipt body. Provider success
// is never inferred from an oversized, malformed, or incomplete receipt.
async function resendReceipt(fetchImpl, options) {
  const controller = new AbortController(); let reader, response, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); cancelReceipt(reader ?? response?.body); reject(new Error('email_provider_receipt_ambiguous'));
  }, 15000); });
  const operation = (async () => {
    response = await fetchImpl('https://api.resend.com/emails', {...options, signal: controller.signal});
    if (controller.signal.aborted || !(response instanceof Response)) throw new Error('email_provider_receipt_ambiguous');
    if (!response.ok) { cancelReceipt(response.body); return {status: response.status, ok: false}; }
    const length = response.headers.get('content-length');
    if ((length !== null && (!/^\d+$/.test(length) || Number(length) > 16384)) || !response.body) throw new Error('email_provider_receipt_ambiguous');
    reader = response.body.getReader(); const chunks = []; let bytes = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (controller.signal.aborted) throw new Error('email_provider_receipt_ambiguous');
      if (done) break;
      if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > 16384 || chunks.length >= 16384) throw new Error('email_provider_receipt_ambiguous');
      chunks.push(value);
    }
    const data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, bytes)));
    return {status: response.status, ok: true, id: data?.id};
  })();
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); controller.abort(); cancelReceipt(reader ?? response?.body); try { reader?.releaseLock(); } catch {} }
}

export async function processWelcomeOutbox({env = process.env, fetchImpl = fetch, limit = 1} = {}) {
  if (env.EMAIL_AUTOMATION_ENABLED !== 'true') return {enabled: false, claimed: 0};
  if (env.SUPABASE_URL !== SUPABASE_ORIGIN || !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.RESEND_API_KEY || !Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error('email_worker_configuration_invalid');
  }
  const {claimConfirmedWelcome, finishConfirmedWelcome} = await import('./runtime/welcome-rpc.mjs');
  let jobs;
  try {
    jobs = await claimConfirmedWelcome({serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, limit, fetchImpl});
  } catch (error) {
    // Translate RPC errors to worker errors, preserving ambiguity markers
    if (error.name === 'WelcomeRpcError') {
      if (/^(claim_job_|claim_duplicate_|claim_response_|response_)/.test(error.code)) {
        throw new Error('email_queue_receipt_invalid');
      }
      throw new Error(error.ambiguous ? 'email_queue_claim_ambiguous' : 'email_queue_rpc_failed');
    }
    throw new Error('email_queue_rpc_failed');
  }
  const result = {enabled: true, claimed: jobs.length, providerAccepted: 0, deferred: 0, failed: 0, ambiguous: 0};
  for (const job of jobs) {
    let message;
    try { message = welcomeMessage(job); }
    catch {
      try {
        await finishConfirmedWelcome({
          serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
          id: job.id,
          leaseId: job.lease_id,
          outcome: 'failed',
          providerId: null,
          fetchImpl,
        });
      } catch { throw new Error('email_queue_finish_ambiguous'); }
      result.failed++; continue;
    }
    let outcome = 'ambiguous', providerId = null;
    try {
      const response = await resendReceipt(fetchImpl, {
        method: 'POST', redirect: 'error',
        headers: {Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
          'Idempotency-Key': `welcome-email/${job.id}`}, body: JSON.stringify(message),
      });
      // A malformed success is ambiguous, never a reason to send a second email.
      if (response.ok) {
        if (UUID.test(response.id || '')) { outcome = 'sent'; providerId = response.id; }
      } else if (response.status === 429 || response.status >= 500) {
        outcome = 'retry';
      } else {
        outcome = 'failed';
      }
    } catch { /* A lost response might have sent. Leave processing for owner reconciliation. */ }
    try {
      await finishConfirmedWelcome({
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        id: job.id,
        leaseId: job.lease_id,
        outcome,
        providerId,
        fetchImpl,
      });
    } catch { throw new Error('email_queue_finish_ambiguous'); }
    if (outcome === 'sent') result.providerAccepted++;
    else if (outcome === 'retry') result.deferred++;
    else if (outcome === 'failed') result.failed++;
    else result.ambiguous++;
  }
  return result; // Counts only: no customer address, credential or provider error text.
}
