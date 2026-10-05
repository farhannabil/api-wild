// A closed build-time runtime boundary, NOT a PostgreSQL/D1 compatibility adapter.
// Only the intended project's public Auth configuration may cross this boundary.
// Never forward the complete environment or any DB/provider/payment credentials.
export function publicSupabaseConfig(source = {}) {
  const url = source.SUPABASE_URL, key = source.SUPABASE_PUBLISHABLE_KEY;
  if (url !== 'https://yautmilnpllojugpmfgy.supabase.co' || typeof key !== 'string') return {};
  let publishable = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publishable && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try {
      const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
      publishable = claims.role === 'anon' && claims.ref === 'yautmilnpllojugpmfgy';
    } catch { /* Invalid or private keys stay unavailable. */ }
  }
  return publishable ? {SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key} : {};
}
const disabled = [
  'BILLING_ENABLED', 'COMMERCE_READY', 'WEBHOOK_INGRESS_VERIFIED',
  'GATEWAY_ENABLED', 'GATEWAY_ACCEPTANCE_VERIFIED',
  'AARO_BILLING_ENABLED', 'AARO_USAGE_ENABLED',
  'SUBROUTER_COMMERCIAL_USE_VERIFIED', 'YOU_COMMERCIAL_USE_VERIFIED',
  'DEEPGRAM_COMMERCIAL_USE_VERIFIED',
];
export const env = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(disabled.map(name => [name, 'false'])), publicSupabaseConfig({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  })));
