import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as offers from '../lib/owned-credit-offers.mjs';
import {verifiedCheckoutUrl} from '../lib/owned-client-config.mjs';
import {createCreditOfferPolicy} from '../infra/railway/runtime/credit-offers.mjs';

const start=Date.parse('2026-10-05T18:00:00.000Z');
const offer={id:'launch-dollar',name:'API WILD $1 credits',priceCents:100,bonusCents:0,totalCreditCents:100,endsAt:new Date(start+60*60000).toISOString()};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(temporaryOffer) {
  let now=start,index=0,Component,checkoutResolve;
  const state=[],effects=[],intervals=[],calls=[],redirects=[],saved=new Map();
  const prices={smart:'price_SmartFixture',nerd:'price_NerdFixture',newton:'price_NewtonFixture',alien:'price_AlienFixture'};
  const data={balanceCents:0,orders:[],checkoutEnabled:true,minimumTopupCents:3000,creditOffers:createCreditOfferPolicy({prices}).read(),temporaryOffer};
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const react={createElement:(type,props,...children)=>({type,props:props??{},children}),Fragment:'fragment',
    useState(initial){const key=index++;if(!(key in state))state[key]=initial;return[state[key],value=>{state[key]=typeof value==='function'?value(state[key]):value;}];},
    useRef(initial){const key=index++;if(!(key in state))state[key]={current:initial};return state[key];},
    useEffect(fn){effects.push(fn);}};
  const module={exports:{}};
  const source=ts.transpileModule(readFileSync('app/console/billing-client.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React},reportDiagnostics:true});
  assert.equal(source.diagnostics.filter(item=>item.category===ts.DiagnosticCategory.Error).length,0);
  const require=name=>{
    if(name==='react')return react;
    if(name==='@/lib/owned-credit-offers.mjs')return {...offers,verifiedTemporaryCreditOffer:value=>offers.verifiedTemporaryCreditOffer(value,now),checkoutRequest:(storage,identity)=>offers.checkoutRequest(storage,identity,()=> 'checkout-dollar-ui-once-0001')};
    if(name==='@/lib/owned-client-config.mjs')return {verifiedCheckoutUrl};
    if(name==='@/app/public-credit-pack-cards')return {CreditPackCards:'public-pack-cards'};
    if(name==='@/lib/customer-api')return {customerApi:async(path,options)=>{calls.push({path,options});if(path==='/api/billing')return data;return new Promise(resolve=>{checkoutResolve=resolve;});}};
    throw Error(`Unexpected module: ${name}`);
  };
  // React's classic JSX emit requires this global in the isolated test renderer.
  vm.runInNewContext(source.outputText,{module,exports:module.exports,require,React:react,Date:Clock,Intl,Error,Number,JSON,URLSearchParams,
    setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval:()=>{},
    location:{search:'',assign:url=>redirects.push(url)},sessionStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},
    crypto:{randomUUID:()=> 'checkout-dollar-ui-once-0001'}});
  Component=module.exports.default;
  const render=()=>{index=0;effects.length=0;return Component();};
  return {calls,redirects,render,effects,intervals,advance:time=>{now=time;},complete:()=>checkoutResolve({packageId:'launch-dollar',orderId:'order-dollar',url:'https://checkout.stripe.com/c/pay/fixture'})};
}
function nodes(tree) {
  if(!tree||typeof tree!=='object')return[];
  if(Array.isArray(tree))return tree.flatMap(nodes);
  return[tree,...(tree.children??[]).flatMap(nodes)];
}
const text=tree=>typeof tree==='string'?tree:Array.isArray(tree)?tree.map(text).join(' '):tree&&typeof tree==='object'?(tree.children??[]).map(text).join(' '):'';
async function loaded(value){const view=fixture(value);view.render();view.effects[0]();await flush();const tree=view.render();return{view,tree};}

test('authenticated private dollar offer renders usable credit and expiry without changing packs or custom minimum',async()=>{
  const {view,tree}=await loaded(offer);
  assert.match(text(tree),/One-time USD \$1\.00 purchase adds \$1\.00 of usable API WILD credits, with no bonus/);
  assert.ok(text(tree).includes(new Date(Date.parse(offer.endsAt)-31*60000).toISOString()));
  const rendered=nodes(tree),packs=rendered.find(node=>node.type==='public-pack-cards'),input=rendered.find(node=>node.type==='input');
  assert.equal(packs.props.offers.packages.length,4);assert.equal(input.props.min,30);assert.equal(input.props.value,'30');
  const button=rendered.find(node=>node.type==='button'&&text(node)==='Buy $1.00 credits with Stripe');
  button.props.onClick();button.props.onClick();await flush();
  const requests=view.calls.filter(call=>call.path==='/api/billing/checkout');assert.equal(requests.length,1);
  assert.deepEqual(JSON.parse(requests[0].options.body),{packageId:'launch-dollar',requestId:'checkout-dollar-ui-once-0001'});
  view.complete();await flush();assert.deepEqual(view.redirects,['https://checkout.stripe.com/c/pay/fixture']);
});
test('absent, malformed and expired temporary offers never render a dollar checkout',async()=>{
  for(const value of [undefined,null,{...offer,priceCents:99},{...offer,bonusCents:1},{...offer,endsAt:new Date(start).toISOString()}]){
    const {tree}=await loaded(value);assert.ok(!text(tree).includes('Buy $1.00 credits with Stripe'));assert.ok(text(tree).includes('Custom credit top-up'));
  }
});
test('open page hides offer on expiry and stale button cannot submit a checkout',async()=>{
  const {view,tree}=await loaded(offer),button=nodes(tree).find(node=>node.type==='button'&&text(node)==='Buy $1.00 credits with Stripe');
  view.effects[1]();view.advance(Date.parse(offer.endsAt)-31*60000);button.props.onClick();await flush();
  assert.equal(view.calls.filter(call=>call.path==='/api/billing/checkout').length,0);
  view.intervals[0]();assert.ok(!text(view.render()).includes('Buy $1.00 credits with Stripe'));
});
