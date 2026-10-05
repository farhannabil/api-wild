// Checks provider inclusion, not a full SPF check_host/mail-delivery verdict.
// SPF include indirection: https://www.rfc-editor.org/rfc/rfc7208#section-5.2
export async function spfIncludesProvider(domain, provider, resolveTxt) {
  let lookups = 0;
  const normalize = value => value.toLowerCase().replace(/\.$/, '');
  const validDomain = value => value.length <= 253 && /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9])?$/.test(value);
  const target = normalize(provider);
  if (!validDomain(target)) return false;
  async function visit(value, ancestors) {
    const host = normalize(value);
    if (!validDomain(host)) return false; // Macros require a full SPF evaluator.
    if (ancestors.has(host)) throw Object.assign(new Error('SPF cycle'), {code:'SPF_CYCLE'});
    if (++lookups > 10) throw Object.assign(new Error('SPF lookup budget'), {code:'SPF_LOOKUP_LIMIT'});
    const records = (await resolveTxt(host)).map(chunks => chunks.join('')).filter(txt => /^v=spf1(?:\s|$)/i.test(txt));
    if (records.length !== 1) return false;
    const terms = records[0].trim().split(/\s+/).slice(1);
    const path = new Set([...ancestors, host]);
    for (const term of terms) {
      if (/^[+?~-]?all$/i.test(term)) return false; // Later includes cannot match.
      const match = /^\+?include:([^\s]+)$/i.exec(term);
      if (!match) continue; // Negative/neutral includes do not authorize the provider.
      const included = normalize(match[1]);
      if (included === target || await visit(included, path)) return true;
    }
    return false;
  }
  return visit(domain, new Set());
}
