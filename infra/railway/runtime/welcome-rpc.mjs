// Bounded HTTPS RPC transport for claim_confirmed_welcome and finish_confirmed_welcome.
// Server-only, fixed yautmilnpllojugpmfgy origin, finite deadlines, 32KB byte-limited
// streamed JSON, reject redirect/malformed/outsize/unexpected shape.
export const SUPABASE_ORIGIN = 'https://yautmilnpllojugpmfgy.supabase.co';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 32768;
const ALLOWED_OUTCOMES = Object.freeze(['sent', 'retry', 'failed', 'ambiguous']);

export class WelcomeRpcError extends Error {
  constructor(code, ambiguous = false) {
    super(code);
    this.name = 'WelcomeRpcError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

function strictUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new WelcomeRpcError('invalid_uuid');
  }
  return value;
}

function strictOutcome(value) {
  if (typeof value !== 'string' || !ALLOWED_OUTCOMES.includes(value)) {
    throw new WelcomeRpcError('invalid_outcome');
  }
  return value;
}

function strictProviderId(value) {
  if (value !== null && (typeof value !== 'string' || !UUID.test(value))) {
    throw new WelcomeRpcError('invalid_provider_id');
  }
  return value;
}

function cancelBody(body) {
  // Cancellation is best-effort and never awaited: an uncooperative stream
  // must not extend the operation deadline or expose its rejection contents.
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {}
}

async function streamedJsonWithLimit(response, maxBytes, signal, setReader) {
  if (!response.body) throw new WelcomeRpcError('response_malformed');
  const reader = response.body.getReader();
  setReader(reader);
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (signal.aborted) throw new WelcomeRpcError('response_read_failed', true);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new WelcomeRpcError('response_malformed');
      totalBytes += value.byteLength;
      // Bound frame bookkeeping too: endless zero-byte chunks cannot evade the
      // byte bound, exhaust memory, or starve the wall timer through microtasks.
      if (totalBytes > maxBytes || chunks.length >= maxBytes) {
        cancelBody(reader);
        throw new WelcomeRpcError('response_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WelcomeRpcError) throw error;
    throw new WelcomeRpcError('response_read_failed', true);
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, totalBytes));
    return JSON.parse(text);
  } catch {
    throw new WelcomeRpcError('response_malformed');
  }
}

function validateKey(serviceRoleKey) {
  if (typeof serviceRoleKey !== 'string' || !serviceRoleKey.trim() ||
      serviceRoleKey.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(serviceRoleKey)) {
    throw new WelcomeRpcError('missing_service_role_key');
  }
}

async function rpc(name, payload, serviceRoleKey, fetchImpl) {
  const prefix = name.startsWith('claim_') ? 'claim' : 'finish';
  if (!['claim_confirmed_welcome', 'claim_apiwild_confirmed_welcome', 'finish_confirmed_welcome'].includes(name)) {
    throw new WelcomeRpcError('invalid_operation');
  }
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new WelcomeRpcError('request_too_large');
  const controller = new AbortController();
  let response, reader, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new WelcomeRpcError(`${prefix}_timeout`, true));
      controller.abort();
      cancelBody(reader ?? response?.body);
    }, 10000);
  });
  const operation = (async () => {
    try {
      response = await fetchImpl(`${SUPABASE_ORIGIN}/rest/v1/rpc/${name}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {apikey: serviceRoleKey, ...(serviceRoleKey.startsWith('sb_secret_') ? {} : {Authorization: `Bearer ${serviceRoleKey}`}), 'Content-Type': 'application/json'},
        body,
      });
    } catch {
      throw new WelcomeRpcError(`${prefix}_network_failed`, true);
    }
    // A late response from an injected transport must not restart body work.
    if (controller.signal.aborted) {
      cancelBody(response?.body);
      throw new WelcomeRpcError(`${prefix}_timeout`, true);
    }
    if (!(response instanceof Response)) throw new WelcomeRpcError('response_malformed');
    if (!response.ok) {
      cancelBody(response.body);
      throw new WelcomeRpcError(`${prefix}_rpc_failed`);
    }
    if (prefix === 'finish' && response.status === 204) return null;
    return streamedJsonWithLimit(response, MAX_BODY_BYTES, controller.signal, value => { reader = value; });
  })();
  try {
    // One absolute deadline covers fetch AND streamed body, even if a fixture
    // transport ignores AbortSignal. No retry or second mutation is attempted.
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    cancelBody(reader ?? response?.body);
  }
}

export async function claimConfirmedWelcome({serviceRoleKey, limit, brand, fetchImpl = fetch}) {
  validateKey(serviceRoleKey);
  if (brand !== undefined && brand !== 'apiwild') throw new WelcomeRpcError('invalid_brand_scope');
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new WelcomeRpcError('invalid_limit');
  }

  const data = await rpc(brand === 'apiwild' ? 'claim_apiwild_confirmed_welcome' : 'claim_confirmed_welcome', {p_limit: limit}, serviceRoleKey, fetchImpl);

  if (!Array.isArray(data)) {
    throw new WelcomeRpcError('claim_response_not_array');
  }

  if (data.length > limit) {
    throw new WelcomeRpcError('claim_response_too_many');
  }

  // Validate entire batch before returning
  const seenIds = new Set();
  const seenLeaseIds = new Set();

  for (const job of data) {
    if (!job || typeof job !== 'object' || Array.isArray(job) || Object.keys(job).length !== 5 ||
        Object.keys(job).some(key => !['id', 'lease_id', 'brand_slug', 'recipient', 'template'].includes(key))) {
      throw new WelcomeRpcError('claim_job_invalid_shape');
    }

    try {
      strictUuid(job.id);
      strictUuid(job.lease_id);
    } catch {
      throw new WelcomeRpcError('claim_job_invalid_ids');
    }

    const canonicalId = job.id.toLowerCase(), canonicalLease = job.lease_id.toLowerCase();
    if (seenIds.has(canonicalId)) {
      throw new WelcomeRpcError('claim_duplicate_id');
    }
    if (seenLeaseIds.has(canonicalLease)) {
      throw new WelcomeRpcError('claim_duplicate_lease_id');
    }

    seenIds.add(canonicalId);
    seenLeaseIds.add(canonicalLease);

    // Validate brand and template
    if (typeof job.brand_slug !== 'string' || !job.brand_slug.trim()) {
      throw new WelcomeRpcError('claim_job_missing_brand');
    }
    if (!['apiwild', 'aaro'].includes(job.brand_slug)) throw new WelcomeRpcError('claim_job_invalid_brand');
    if (brand && job.brand_slug !== brand) throw new WelcomeRpcError('claim_job_invalid_brand');
    if (job.template !== 'confirmed-welcome-v1') {
      throw new WelcomeRpcError('claim_job_invalid_template');
    }

    // Validate recipient
    if (typeof job.recipient !== 'string' || job.recipient.length === 0 || job.recipient.length > 254) {
      throw new WelcomeRpcError('claim_job_invalid_recipient');
    }
    if (/[\u0000-\u001f\u007f]/.test(job.recipient)) {
      throw new WelcomeRpcError('claim_job_invalid_recipient');
    }
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(job.recipient)) {
      throw new WelcomeRpcError('claim_job_invalid_recipient');
    }
  }

  return data.map(job => ({...job, id: job.id.toLowerCase(), lease_id: job.lease_id.toLowerCase()}));
}

export async function finishConfirmedWelcome({serviceRoleKey, id, leaseId, outcome, providerId, fetchImpl = fetch}) {
  validateKey(serviceRoleKey);

  strictUuid(id);
  strictUuid(leaseId);
  strictOutcome(outcome);
  strictProviderId(providerId);

  // Validate outcome/provider pairing: sent requires UUID, others require null
  if (outcome === 'sent' && providerId === null) {
    throw new WelcomeRpcError('sent_requires_provider_id');
  }
  if (outcome !== 'sent' && providerId !== null) {
    throw new WelcomeRpcError('non_sent_requires_null_provider');
  }

  const data = await rpc('finish_confirmed_welcome', {
    p_id: id.toLowerCase(),
    p_lease_id: leaseId.toLowerCase(),
    p_outcome: outcome,
    p_provider_id: providerId === null ? null : providerId.toLowerCase(),
  }, serviceRoleKey, fetchImpl);

  if (data !== null) {
    throw new WelcomeRpcError('finish_unexpected_response');
  }

  return null;
}
