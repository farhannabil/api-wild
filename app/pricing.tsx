'use client';
import PublicCreditPackCards from '@/app/public-credit-pack-cards';
import SelectedSuppliers from '@/app/models/selected-suppliers';
import {useEffect,useState} from 'react';
import approvedCatalog from '@/app/models/public-models.json';
import {listedCustomerModels} from '@/app/models/callable-catalogue.mjs';
import {retailEstimate} from '@/lib/retail-estimate.mjs';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
type Model=typeof approvedCatalog.models[number] & {chargedPricing?:{input:number;output:number;rateVersion:string;billingPolicy:string;rounding:string}|null};
const usd=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6}).format(n);
export default function Pricing(){
 const [models,setModels]=useState<Model[]|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
 const [tier,setTier]=useState<'off_peak'|'peak'>('off_peak');
 const [id,setId]=useState(''),[input,setInput]=useState('1000000'),[output,setOutput]=useState('1000000');
 useEffect(()=>{
  const controller=new AbortController();setModels(null);setError(false);
  fetch('/api/models',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])})
   .then(async r=>{if(!r.ok)throw Error('Unavailable');return r.json();})
   .then(data=>{const active=listedCustomerModels(data,approvedCatalog.models);if(!controller.signal.aborted)setModels(active);})
   .catch(()=>{if(!controller.signal.aborted)setError(true);});
  return()=>controller.abort();
 },[attempt]);
 const model=models?.find(m=>m.model_name===id)??models?.[0];
 const price=model?.apiwild_selling_price;
 const charged=model?.chargedPricing;
 const reference=model?.official_reference;
 const referenceRates=reference?.peak&&tier==='peak'?reference.peak:reference;
 let estimate:number|null=null,official:number|null=null;
 if(model&&charged){try{estimate=retailEstimate(charged.input,charged.output,Number(input||0),Number(output||0));official=retailEstimate(referenceRates!.input,referenceRates!.output,Number(input||0),Number(output||0));}catch{}}
 return <main id="main" className="content-page pricing-page">
  <div className="content-heading"><span className="section-overline">MODEL PRICING · USD</span><h1>Pay for the tokens<br/>you actually use.</h1><p>One prepaid USD wallet for Chat, Code and Research. API WILD rates below are the customer rate charged per 1M tokens; OpenRouter and official API figures are list comparisons. Actual credits are deducted at 5× supplier USD cost, with no extra fees currently added.</p></div>
  <section id="usage-calculator" className="catalog-calculator">
   <div className="calculator-heading"><span className="section-overline">API WILD USAGE CALCULATOR</span><h2>Estimate your model cost.</h2><p>Enter input and output token counts separately. Rates below are USD per one million uncached input or text output tokens.</p><p>Billing rule: exact integer arithmetic, rounded up, 500,000 supplier quota units = USD 1, ×5, zero extra fee.</p></div>
   {error?<p role="alert">Current model availability could not be verified. <button className="pill-button outline" onClick={()=>setAttempt(n=>n+1)}>Retry</button></p>:models===null?<p role="status">Loading current model prices…</p>:!model?<p role="status">No models are currently available.</p>:<>
    <div className="calculator-model-choice"><label htmlFor="pricing-model">Model</label><Select value={model.model_name} onValueChange={setId}><SelectTrigger id="pricing-model" aria-label="Model for API WILD estimate"><SelectValue/></SelectTrigger><SelectContent>{models.map(m=><SelectItem key={m.model_name} value={m.model_name}>{m.model_name}</SelectItem>)}</SelectContent></Select></div>
    {price?.peak&&<div className="calculator-model-choice"><label htmlFor="pricing-tier">DeepSeek pricing tier</label><select id="pricing-tier" value={tier} onChange={e=>setTier(e.target.value as 'off_peak'|'peak')}><option value="off_peak">Off-peak</option><option value="peak">Peak</option></select><p>{price.tier_schedule} This selector previews the reference tier. Actual credit deductions use verified supplier USD cost ×5.</p></div>}
    <div className="usage-price-grid">
     <div className="usage-price-item"><label htmlFor="pricing-input">Input tokens</label><strong>{charged?usd(charged.input):'Unavailable'} <small>rate charged · / 1M input tokens</small></strong><p className="section-fine">List comparison: {usd(price?.input??0)} / 1M</p><input id="pricing-input" type="number" min="0" max="1000000000" step="1" value={input} onChange={e=>setInput(e.target.value)}/></div>
     <div className="usage-price-item"><label htmlFor="pricing-output">Output tokens</label><strong>{charged?usd(charged.output):'Unavailable'} <small>rate charged · / 1M output tokens</small></strong><p className="section-fine">List comparison: {usd(price?.output??0)} / 1M</p><input id="pricing-output" type="number" min="0" max="1000000000" step="1" value={output} onChange={e=>setOutput(e.target.value)}/></div>
    </div>
    <div className="estimate-total" aria-live="polite"><span>Rate charged estimate</span><strong>{estimate===null?'Current charged rate unavailable':usd(estimate)}</strong></div>
    {official!==null&&estimate!==null&&<p>{model.official_reference.reference_label} estimate for the same tokens: <b>{usd(official)}</b>. The reference-price difference is <b>{usd(official-estimate)}</b> before purchase bonuses. <a className="text-link" href={model.official_reference.source} target="_blank" rel="noreferrer">Price reference ↗</a> <small>Reference checked {model.official_reference.checked_date}.</small></p>}
    <p className="section-fine">Base-rate volume estimate, rounded once to the nearest $0.000001 upward. Large totals represent multiple requests; each actual request has input/output limits and rounds separately. This reference calculation is not the wallet deduction. Actual billing uses verified supplier cost × 5. Long-context, cache, audio and optional provider tools are not included.</p>
   </>}
  </section>
  <div className="offering-title"><span className="section-overline">PREPAID CREDIT</span><h2>Add dollars. Use any available model.</h2><p>Custom top-ups start at $30 and add the same amount to your wallet. These are one-time purchases. Pack bonuses are shown separately; credit does not represent a fixed number of tokens.</p><a className="pill-button dark" href="/console/billing">Manage credits →</a></div>
  <PublicCreditPackCards/>
  <SelectedSuppliers/>
  <section className="pricing-custom"><h2>Need a custom integration?</h2><p>Describe your workflow, expected volume and requirements for a scoped quote.</p><a href="/contact" className="pill-button dark">Discuss your project →</a><a href="/models" className="text-link">Browse available models ↗</a></section>
 </main>;
}
