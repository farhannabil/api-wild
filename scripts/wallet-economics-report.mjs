// Owner-only report. Never copy supplier economics into public model assets.
import {readFile,writeFile} from 'node:fs/promises';import {createModelAccounting} from '../infra/railway/runtime/model-accounting.mjs';
const catalog=JSON.parse(await readFile(new URL('../data/selected-supplier-models.json',import.meta.url),'utf8'));
const accounting=createModelAccounting({catalog,rateVersion:catalog.inventory_snapshot});
const usd=n=>'$'+(n/1e6).toFixed(4);
const rows=catalog.models.flatMap(m=>[m.apiwild_selling_price.processing,...(m.apiwild_selling_price.peak?['peak']:[])].map(tier=>{
 const q=accounting.quote({model:m.model_name,promptTokens:1000000,completionTokens:1000000,tier});
 return '| '+[m.model_name,tier,usd(q.retailUsdMicros),usd(q.estimatedSupplierUsdMicros),usd(q.estimatedGrossUsdMicros),usd(30000000*q.estimatedSupplierUsdMicros/q.retailUsdMicros)].join(' | ')+' |';
}));
await writeFile(new URL('../MODEL_WALLET_ECONOMICS.md',import.meta.url),[
 '# API WILD model wallet economics — owner only','',
 'Quote snapshot: '+catalog.inventory_snapshot+'. CNY/USD reference: '+catalog.fx.CNY_USD+'. Supplier quotes and FX are estimates, not verified actual charges.',
 'All 39 models use their own retail and supplier rates. One customer USD wallet is shared across models. No universal $8 supplier allowance per $30 purchase.',
 'Each row uses 1M uncached input + 1M output. The last column scales that 1:1 token mix to $30 retail; it is not a guaranteed budget for arbitrary input/output, cache, context tiers, or fees.',
 'Peak/off-peak are explicit scenarios. The two DeepSeek routes remain inactive until authoritative timing/version rules are verified. All upstream routes still require actual debit reconciliation.',
 '', '| Model | Tier | Customer debit | Supplier estimate | Gross before fees | Supplier estimate for $30 retail (1:1 token mix) |',
 '|---|---|---:|---:|---:|---:|',...rows,'',
 'Customer debit = ceil((input tokens × input USD micros per million + output tokens × output USD micros per million) / 1,000,000). Round once per request to the existing ledger micro-unit; do not round individual tokens or UI updates.',
 'Reserve customer and supplier balances atomically. Retail settlement releases unused retail reserve; supplier reserve remains pending until the actual supplier charge is verified. Unknown or unsupported tariffs must not execute.',
 ].join('\n'));
