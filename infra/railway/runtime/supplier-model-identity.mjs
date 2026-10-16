// One reviewed supplier alias, backed by an immutable native receipt. No generic
// prefix removal or inference that a response label proves manufacturer origin.
export function canonicalSupplierModel(value,{supplierSlug,model,upstreamModel=model}={}){
 if(value===upstreamModel)return value;
 if(supplierSlug==='a6aa'&&model==='deepseek-v4.1-flash'&&upstreamModel===model&&value==='cb/deepseek-v4.1-flash')return model;
 if(supplierSlug==='viapi'&&model==='grok-4.5'&&upstreamModel===model&&value==='grok-4.5-build')return model;
 if(supplierSlug==='a6aa'&&model==='gemini-3.8-flash'&&upstreamModel===model&&value==='gemini-3.8-flash-high')return model;
 return null;
}
