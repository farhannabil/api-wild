// One reviewed supplier alias, backed by an immutable native receipt. No generic
// prefix removal or inference that a response label proves manufacturer origin.
export function canonicalSupplierModel(value,{supplierSlug,model,upstreamModel=model}={}){
 if(value===upstreamModel)return value;
 if(supplierSlug==='a6aa'&&model==='deepseek-v4.1-flash'&&upstreamModel===model&&value==='cb/deepseek-v4.1-flash')return model;
 return null;
}
