// The four reviewed bangai pairs use opaque eight-hex response/log identities.
// Other routes keep the UUID contract; completion-ID fallbacks are unsupported.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bangaiModels=new Set(['claude-opus-4-6','claude-opus-4-7','gpt-6-astra','gpt-6-sol']);
export function isSupplierRequestIdentity(value,{supplierSlug,model}={}){
 return typeof value==='string'&&(uuid.test(value)||(
  supplierSlug==='bangai'&&bangaiModels.has(model)&&/^[0-9a-f]{8}$/.test(value)));
}
