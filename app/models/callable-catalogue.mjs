// Availability is read-only; published customer prices come from the approved snapshot.
export const customerRouteExamples = Object.freeze([
  Object.freeze({id:'chat', name:'Chat', model:'gpt-6-astra'}),
  Object.freeze({id:'code', name:'Code', model:'gpt-6-sol'}),
  Object.freeze({id:'research', name:'Research', model:'gemini-3.1-pro-preview'}),
]);
/**
 * @template {{model_name: string}} T
 * @param {unknown} data
 * @param {readonly T[]} approved
 * @returns {T[]}
 */
export function callableCustomerModels(data, approved) {
  const invalid = () => {throw Error('Model availability could not be verified. Please retry.');};
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || data.schemaVersion !== 1 || data.authority !== 'apiwild-owned-runtime'
      || data.source !== 'apiwild-approved-retail' || !Array.isArray(data.models)
      || data.models.length > 2000 || data.count !== data.models.length) invalid();
  const seen = new Set(), active = new Set();
  for (const row of data.models) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string'
        || !row.id || row.id.length > 160 || row.id.trim() !== row.id || /[\x00-\x1f\x7f]/.test(row.id)
        || typeof row.callable !== 'boolean' || seen.has(row.id)
        || !Array.isArray(row.capabilities) || row.capabilities.length > 3
        || new Set(row.capabilities).size !== row.capabilities.length
        || row.capabilities.some(value => !['chat', 'code', 'research'].includes(value))
        || (row.callable && !row.capabilities.length)) invalid();
    seen.add(row.id);
    if (row.callable) active.add(row.id);
  }
  return approved.filter(row => active.has(row.model_name));
}
