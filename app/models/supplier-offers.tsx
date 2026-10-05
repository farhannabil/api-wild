import {supplierQuote,type SupplierOffer} from '@/lib/catalog-display';

export default function SupplierOffers({offers}:{offers:SupplierOffer[]}){
 return <>
  <h3>Advertised supplier quotes</h3>
  <p className="muted">These are SubRouter supplier quotes, not approved API WILD selling prices. CNY and USD are not converted. No supplier is selected automatically by this directory.</p>
  {!offers.length&&<p>No public supplier offer was found. A pricing-index name alone does not establish cost or customer access.</p>}
  <div className="model-price-lines">{offers.map(offer=><section key={offer.id}>
   <h4>{offer.providerName} · offer {offer.id}</h4>
   <p className="muted">{offer.category} · {offer.currency} · {offer.billingMode}</p>
   {offer.billingMode==='ratio'?<>
    <div><strong>Input / 1M tokens</strong><span>{supplierQuote(offer.inputPrice,offer.currency)}</span></div>
    <div><strong>Output / 1M tokens</strong><span>{supplierQuote(offer.outputPrice,offer.currency)}</span></div>
   </>:offer.billingMode==='per_call'?<div><strong>Fixed base quote / call</strong><span>{supplierQuote(offer.fixedPrice,offer.currency)}</span></div>:<p>Tiered or conditional pricing — no simple token price is assumed.</p>}
   {offer.billingExpression&&<details><summary>Advertised billing formula (not executed)</summary><code style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{offer.billingExpression}</code></details>}
   {offer.billingMode==='per_call'&&<p className="muted">Verify the exact size, duration and request parameters before accepting a per-call quote.</p>}
   <p className="muted">Station listing: unknown · Customer call: not enabled · API WILD test: not run. {offer.pricingAuthoritative?'Platform marks this quote authoritative.':'Platform does not mark this quote authoritative.'}</p>
   <details><summary>Interfaces, cache quotes and platform evidence</summary>
    <p>Supplier: {offer.providerSlug} · Upstream label: {offer.upstreamModel||'not reported'}</p>
    <p>Reported source: {offer.source||'regular marketplace'} · Official channel reference: {offer.officialChannelId||'not reported'}</p>
    <p>Advertised features: {offer.reportedFeatures===null?'not reported':JSON.stringify(offer.reportedFeatures)}. Features are supplier reports, not accepted capability tests.</p>
    <p>Reported context: {offer.context?offer.context.toLocaleString():'unknown'}</p>
    {offer.endpointParseError&&<p>Interface metadata could not be parsed; no interface is assumed.</p>}
    {offer.endpoints.map((endpoint,index)=><p key={index}>{endpoint.protocol} · {endpoint.method} {endpoint.path}</p>)}
    {Object.entries(offer.cachePrices).map(([name,value])=><div key={name}><strong>{name} cache / 1M tokens</strong><span>{supplierQuote(value,offer.currency)}</span></div>)}
    <p>Cache authority: {offer.cachePricingAuthoritative?'platform-authoritative':'not established'}. Effective cache quotes are platform reports, not reconciled debits.</p>
    <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(offer.platformEvidence,null,2)}</pre>
   </details>
   <a href={`https://subrouter.ai/models/${offer.id}`} target="_blank" rel="noreferrer">Public supplier offer ↗</a>
  </section>)}</div>
 </>;
}
