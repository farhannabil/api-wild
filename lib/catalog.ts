import snapshot from '@/data/models.json';
export type PriceTier={sku_label:string;price:string};
export type DisplayPrice={kind:string;sku_label:string;price:string;displayMultiplier:number;unitLabel:string;tiers?:PriceTier[]};
export type CatalogModel={id:string;name:string;shortName:string;provider:string;providerName:string;logo:string;context:number;input:string[];output:string[];parameters:string[];pricing:{input:string|null;output:string|null};displayPricing:DisplayPrice[];created:number;description:string;sourceUrl:string;previewImage:string|null;pricingUnresolved:boolean};
export type CatalogSnapshot={models:CatalogModel[];source:string;fetchedAt:string;count:number};
export const catalog:CatalogSnapshot=snapshot;
export function dollars(amount:number){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:10}).format(amount);}
export function price(value:string|null){if(value===null||!Number.isFinite(Number(value))||Number(value)<0)return 'Dynamic';const amount=Number(value)*1e6;return amount===0?'Free':dollars(amount);}
export function displayPrice(row:DisplayPrice,value=row.price){const n=Number(value);return !Number.isFinite(n)||n<0?'Dynamic':dollars(n*row.displayMultiplier);}
export function textInputPrice(model:CatalogModel){const row=model.displayPricing.find(r=>r.kind==='token'&&r.sku_label==='Input Price');const n=row?Number(row.price):NaN;return Number.isFinite(n)&&n>=0?n:Infinity;}
