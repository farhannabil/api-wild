// Public discovery only. This module never receives credentials or grants execution.
export const PUBLIC_ORIGIN = 'https://subrouter.ai';
const MAX_PROVIDERS = 2000, MAX_MODELS = 20000, MAX_OFFERS = 100000;
const MAX_SCAN_BYTES = 64*1024*1024, MAX_SNAPSHOT_BYTES = 16*1024*1024;
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const number = value => Number.isFinite(Number(value)) && value !== null ? Number(value) : 0;
const rate = value => ['string','number'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? String(value) : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function required(condition, message) { if (!condition) throw new Error(message); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function modelName(value) { required(typeof value === 'string' && value.length > 0 && value.length <= 500, 'Invalid model identity'); return value; }
function unique(rows, key, label) {
  const result = new Map();
  for (const row of rows) {
    required(object(row), `Invalid ${label} row`);
    const id = key(row);
    required(id !== undefined && id !== null, `Missing ${label} identity`);
    if (result.has(id)) required(same(result.get(id), row), `Conflicting ${label} identity`);
    else result.set(id, row);
  }
  return [...result.values()];
}
function endpoints(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!object(parsed)) return {rows:[], error:true};
    let error = false;
    const rows = Object.entries(parsed).flatMap(([protocol,item])=>{
      if (!object(item)) { error = true; return []; }
      const path = text(item.path), method = text(item.method);
      if (!path.startsWith('/') || /[\r\n]/.test(path) || !['GET','POST','PUT','PATCH','DELETE'].includes(method)) error = true;
      return [{protocol,path,method}];
    });
    return {rows,error};
  } catch { return {rows:[], error:true}; }
}
function normalizeOffer(row, provider) {
  required(Number.isSafeInteger(row.id) && Number.isSafeInteger(row.provider_id) && row.provider_id === provider.id, 'Offer/provider mismatch');
  required(row.status === 1 && row.is_public === true, 'Offer is not declared active and public');
  const interfaces = endpoints(row.endpoints);
  const evidence = {};
  for (const key of ['risk_summary','availability','is_official_locked','official_channel_key_count','status','is_public','auto_delist_locked']) {
    if (row[key] !== undefined) evidence[key] = row[key];
  }
  // Keep platform-reported verdicts, not the large raw probe prompts/responses.
  // The supplier's public offer page remains the source for the complete report.
  evidence.probe_summaries = object(row.probe_results) ? Object.fromEntries(Object.entries(row.probe_results).map(([source,probe])=>[source,object(probe)?Object.fromEntries(['id','status','score','score_available','verdict','detected_model','latency_ms','model_replacement_risk','created_time','updated_time'].filter(key=>['string','number','boolean'].includes(typeof probe[key])).map(key=>[key,probe[key]])):{}])) : {};
  evidence.provider_rating = provider.rating ?? null;
  evidence.provider_review_count = provider.credit_review_count ?? null;
  evidence.provider_verified = provider.verified === true;
  required(JSON.stringify(evidence).length <= 100000, 'Oversized platform evidence');
  const reportedFeatures = row.features ?? null;
  required(JSON.stringify(reportedFeatures).length <= 4096, 'Oversized feature metadata');
  return {
    id:row.id, providerId:provider.id, providerSlug:provider.slug,
    providerName:text(provider.company_name,provider.slug), upstreamModel:text(row.upstream_model),
    category:text(row.category,'unknown'), context:number(row.context_length), endpoints:interfaces.rows,
    endpointParseError:interfaces.error, currency:text(row.price_currency,'UNKNOWN'), billingMode:text(row.billing_mode,'unknown'),
    inputPrice:rate(row.input_price), outputPrice:rate(row.output_price), fixedPrice:rate(row.fixed_price),
    // Formula text is inert. A zero input/output field is not a free tiered offer.
    billingExpression:typeof row.billing_expr === 'string' ? row.billing_expr : null,
    cachePrices:{read:rate(row.cache_read_price),creation:rate(row.cache_creation_price),creation1h:rate(row.cache_creation_price_1h),effectiveRead:rate(row.effective_cache_read_price),effectiveCreation:rate(row.effective_cache_creation_price),effectiveCreation1h:rate(row.effective_cache_creation_price_1h)},
    pricingAuthoritative:row.pricing_authoritative === true, cachePricingAuthoritative:row.cache_pricing_authoritative === true,
    source:text(row.source), officialChannelId:Number.isSafeInteger(row.official_channel_id)?row.official_channel_id:null,
    reportedFeatures, platformEvidence:evidence, stationListed:'unknown', callable:false, tested:'not-run',
  };
}
function capabilities(categories) {
  const input = new Set(), output = new Set();
  for (const category of categories) {
    if (['chat','completion','responses'].includes(category)) { input.add('text'); output.add('text'); }
    else if (category === 'embedding') { input.add('text'); output.add('embeddings'); }
    else if (category === 'rerank') { input.add('text'); output.add('rerank'); }
    else if (category === 'speech-to-text') { input.add('audio'); output.add('transcription'); }
    else if (category === 'text-to-speech') { input.add('text'); output.add('speech'); output.add('audio'); }
    else if (category === 'image-to-video') { input.add('image'); output.add('video'); }
    else if (category === 'image-to-image') { input.add('image'); output.add('image'); }
    else if (category === 'image-to-3d') { input.add('image'); output.add('3d'); }
    else if (['image','text-to-image'].includes(category)) { input.add('text'); output.add('image'); }
    else if (['video','text-to-video'].includes(category)) { input.add('text'); output.add('video'); }
    else output.add('unknown');
  }
  if (!output.size) output.add('unknown');
  return {input:[...input], output:[...output]};
}

export function normalizeCatalogue(pricing, providerList, details, fetchedAt) {
  required(pricing?.success === true && Array.isArray(pricing.data) && pricing.data.length > 0, 'Incomplete pricing index');
  required(pricing.data.length <= MAX_MODELS && Array.isArray(providerList) && providerList.length > 0 && providerList.length <= MAX_PROVIDERS, 'Catalogue bounds exceeded');
  const providers = unique(providerList, row => row.id, 'provider');
  required(new Set(providers.map(row => row.slug)).size === providers.length, 'Conflicting provider slug');
  required(Array.isArray(details) && details.length === providers.length, 'Missing supplier details');
  const byId = new Map(providers.map(provider => [provider.id,provider]));
  const visited = new Set(), offersByName = new Map(), offersById = new Map();
  let rawOfferCount = 0, normalizedOfferBytes = 0;
  for (const envelope of details) {
    required(envelope?.success === true && object(envelope.data), 'Incomplete supplier response');
    const {provider,models,public_model_count,filtered_model_count} = envelope.data;
    required(object(provider) && byId.has(provider.id) && byId.get(provider.id).slug === provider.slug && !visited.has(provider.id), 'Unexpected or repeated supplier');
    visited.add(provider.id);
    required(Array.isArray(models) && models.length === public_model_count && models.length === filtered_model_count, 'Incomplete supplier model count');
    rawOfferCount += models.length;
    required(rawOfferCount <= MAX_OFFERS, 'Offer bounds exceeded');
    for (const row of models) {
      const name = modelName(row.model_name), offer = normalizeOffer(row,provider);
      if (offersById.has(offer.id)) {
        required(same(offersById.get(offer.id),{name,offer}), 'Conflicting offer identity');
        continue;
      }
      offersById.set(offer.id,{name,offer});
      normalizedOfferBytes += new TextEncoder().encode(JSON.stringify(offer)).byteLength;
      required(normalizedOfferBytes <= MAX_SNAPSHOT_BYTES, 'Normalized offer bytes exceeded');
      if (!offersByName.has(name)) offersByName.set(name,[]);
      offersByName.get(name).push(offer);
    }
  }
  const pricingRows = unique(pricing.data, row => modelName(row.model_name), 'pricing model');
  const pricingByName = new Map(pricingRows.map(row => [row.model_name,row]));
  const vendorById = new Map((Array.isArray(pricing.vendors)?pricing.vendors:[]).map(row => [row.id,text(row.name,'Unknown creator')]));
  const names = new Set([...pricingByName.keys(),...offersByName.keys()]);
  required(names.size <= MAX_MODELS && Number.isFinite(Date.parse(fetchedAt)), 'Invalid catalogue generation');
  const models = [...names].sort().map(name => {
    const pricingRow = pricingByName.get(name), offers = offersByName.get(name) ?? [];
    const creator = pricingRow ? vendorById.get(pricingRow.vendor_id) ?? 'Unknown creator' : 'Unknown creator';
    const caps = capabilities(offers.map(offer => offer.category));
    return {
      id:name, name, shortName:name.split('/').at(-1), provider:pricingRow?`subrouter-vendor-${pricingRow.vendor_id ?? 'unknown'}`:'subrouter-vendor-unknown', providerName:creator,
      logo:'', context:offers.reduce((max,offer)=>Math.max(max,offer.context),0), ...caps, parameters:[],
      pricing:{input:null,output:null}, displayPricing:[], created:0,
      description:offers.length ? `${offers.length} public supplier offer${offers.length===1?'':'s'}. Advertised interfaces and native-currency quotes are shown in details; API WILD customer access has not been accepted.` : 'SubRouter pricing-index entry. No public supplier offer was found in this complete marketplace generation; availability and cost are unverified.',
      sourceUrl:offers.length?`${PUBLIC_ORIGIN}/models/${offers[0].id}`:`${PUBLIC_ORIGIN}/models`, previewImage:null, pricingUnresolved:true,
      subrouter:{offers,pricingIndexPresent:pricingByName.has(name),advertisedProtocols:Array.isArray(pricingRow?.supported_endpoint_types)?pricingRow.supported_endpoint_types.filter(value=>typeof value==='string'):[]},
    };
  });
  const billingModes = {};
  for (const {offer} of offersById.values()) billingModes[offer.billingMode] = (billingModes[offer.billingMode] ?? 0) + 1;
  const snapshot = {
    source:PUBLIC_ORIGIN, fetchedAt, count:models.length, models,
    subrouter:{schemaVersion:1, providerCount:providers.length, offerCount:offersById.size, marketplaceModelCount:offersByName.size, pricingIndexCount:pricingRows.length, pricingOnlyCount:models.filter(model=>!model.subrouter.offers.length).length, currencies:[...new Set([...offersById.values()].map(({offer})=>offer.currency))].sort(),billingModes,stale:false,refreshError:null},
  };
  required(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= MAX_SNAPSHOT_BYTES, 'Catalogue snapshot bytes exceeded');
  return snapshot;
}

async function publicJson(fetchImpl, path, signal, budget) {
  const url = new URL(path,PUBLIC_ORIGIN);
  required(url.origin === PUBLIC_ORIGIN && url.pathname.startsWith('/api/'), 'Unsafe catalogue URL');
  const response = await fetchImpl(url.href,{method:'GET',redirect:'error',credentials:'omit',headers:{Accept:'application/json'},signal});
  required(response.ok, 'Public catalogue request failed');
  required(Number(response.headers?.get('content-length')??0) <= 10000000, 'Public catalogue response too large');
  required(response.body?.getReader, 'Public catalogue response has no bounded stream');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; budget.bytes += value.byteLength; required(size <= 10000000,'Public catalogue response too large'); required(budget.bytes <= MAX_SCAN_BYTES,'Public scan byte budget exceeded'); chunks.push(value); }
  } finally { await reader.cancel().catch(()=>{}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  const json = JSON.parse(new TextDecoder().decode(bytes));
  required(json?.success === true, 'Public catalogue envelope failed');
  return json;
}
async function allProviders(fetchImpl, signal, budget) {
  let total = null, rows = [], page = 1;
  while (true) {
    const json = await publicJson(fetchImpl,`/api/marketplace/providers?page=${page}&page_size=100`,signal,budget);
    required(Number.isSafeInteger(json.total) && json.total >= 0 && json.total <= MAX_PROVIDERS && Array.isArray(json.data), 'Invalid provider pagination');
    if (total === null) total = json.total;
    required(json.total === total, 'Provider total changed during scan');
    const previousCount = rows.length;
    rows = unique([...rows,...json.data],row=>row.id,'provider');
    required(rows.length <= total, 'Provider count exceeds total');
    if (rows.length === total) return rows;
    required(rows.length > previousCount && page < MAX_PROVIDERS, 'Incomplete provider pagination');
    page++;
  }
}
export async function fetchPublicCatalogue(fetchImpl = fetch, {timeoutMs = 45000, now = () => Date.now()} = {}) {
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),timeoutMs), budget = {bytes:0};
  try {
    const [pricing,providers] = await Promise.all([publicJson(fetchImpl,'/api/pricing',controller.signal,budget),allProviders(fetchImpl,controller.signal,budget)]);
    let cursor = 0; const details = new Array(providers.length);
    async function worker() {
      while (cursor < providers.length) {
        const index = cursor++, provider = providers[index];
        required(typeof provider.slug === 'string' && /^[a-zA-Z0-9_-]+$/.test(provider.slug), 'Unsafe provider slug');
        details[index] = await publicJson(fetchImpl,`/api/marketplace/providers/${encodeURIComponent(provider.slug)}`,controller.signal,budget);
      }
    }
    await Promise.all(Array.from({length:Math.min(4,providers.length)},worker));
    // Detect source churn before publishing, rather than silently losing providers.
    const after = await allProviders(fetchImpl,controller.signal,budget);
    required(same(providers.map(row=>[row.id,row.slug]).sort(),after.map(row=>[row.id,row.slug]).sort()), 'Provider membership changed during scan');
    return normalizeCatalogue(pricing,providers,details,new Date(now()).toISOString());
  } finally { controller.abort(); clearTimeout(timer); }
}
export function createCatalogueLoader({bootstrap,fetchImpl=fetch,now=()=>Date.now(),ttlMs=600000,failureBackoffMs=60000,timeoutMs=45000,waitForRefresh=false}) {
  required(bootstrap?.subrouter?.schemaVersion===1 && bootstrap.models?.length===bootstrap.count && bootstrap.count>0, 'Invalid catalogue bootstrap');
  let snapshot = bootstrap, attemptedAt = null, pending = null;
  return async function load() {
    if (pending) return waitForRefresh ? pending : snapshot;
    const age = now()-Date.parse(snapshot.fetchedAt);
    if (age >= 0 && age < ttlMs && !snapshot.subrouter.stale) return snapshot;
    if (attemptedAt !== null && now()-attemptedAt < failureBackoffMs) return snapshot;
    attemptedAt = now();
    snapshot = {...snapshot,subrouter:{...snapshot.subrouter,stale:true,refreshError:null}};
    pending = (async()=>{
      try { snapshot = await fetchPublicCatalogue(fetchImpl,{timeoutMs,now}); }
      catch { snapshot = {...snapshot,subrouter:{...snapshot.subrouter,stale:true,refreshError:'Refresh incomplete; retaining the last complete public catalogue. Customer access is not enabled by this data.'}}; }
      finally { pending = null; }
      return snapshot;
    })();
    // Never hold the customer page behind a 98-supplier scan. Node/Railway
    // keeps this bounded public refresh alive while serving the durable bootstrap.
    // Offline verification can explicitly wait for the completed generation.
    return waitForRefresh ? pending : snapshot;
  };
}
