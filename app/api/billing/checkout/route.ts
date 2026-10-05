import {database,respond,trustedWrite,readTextBounded,RequestError} from '@/db/service';
import {billingIdentity} from '@/lib/billing-auth';
import {billingConfig,billingOwner,billingHold,customerFor,packs,legacyPacks,stripe} from '@/lib/billing';
import packCatalog from '@/lib/apiwild-packs.json';
import {z} from 'zod';
export async function POST(r:Request){
  if(!trustedWrite(r))return respond({error:'Invalid request origin.'},403);
  try{
    const identity=await billingIdentity(r,true),u={...identity,id:billingOwner(identity.id)},config=billingConfig();
    if(!config.enabled)return respond({error:'Payments are not activated yet. No charge was made.'},503);
    const parsed=z.object({pack:z.enum(['smart','nerd','newton','alien','starter','builder','scale','noob']),purchaseMode:z.literal('one_time').default('one_time'),amountCents:z.number().int().min(500).max(25000).optional(),requestId:z.string().uuid()}).refine(p=>p.pack!=='noob'||p.amountCents!==undefined).safeParse(JSON.parse(await readTextBounded(r,2000)));
    if(!parsed.success)throw new RequestError('Choose a valid credit pack.',400);
    if(await billingHold(u.id)>0)throw new RequestError('A payment is under review. Please contact support before purchasing more credits.',409);
    const db=database(),p=parsed.data;
    const amount=p.pack==='noob'?p.amountCents!:(packs[p.pack]??legacyPacks[p.pack]);
    if(config.mode==='live'){
      const account=await stripe('account');
      if(account.id!==packCatalog.account||account.charges_enabled!==true)throw new RequestError('The payment connection needs attention. No charge was made.',503);
    }
    let order=await db.prepare('SELECT * FROM billing_orders WHERE user_id=? AND request_id=?').bind(u.id,p.requestId).first<any>();
    if(!order){
      const recent=await db.prepare('SELECT COUNT(*) n FROM billing_orders WHERE user_id=? AND created_at>?').bind(u.id,new Date(Date.now()-3600e3).toISOString()).first<{n:number}>();
      if((recent?.n||0)>=10)throw new RequestError('Too many checkout attempts. Try again later.',429);
      await db.prepare('INSERT OR IGNORE INTO billing_orders(id,user_id,request_id,pack,purchase_mode,amount_cents,currency,status,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM billing_orders WHERE user_id=? AND created_at>?)<10').bind(crypto.randomUUID(),u.id,p.requestId,p.pack,p.purchaseMode,amount,'usd','created',new Date().toISOString(),u.id,new Date(Date.now()-3600e3).toISOString()).run();
      order=await db.prepare('SELECT * FROM billing_orders WHERE user_id=? AND request_id=?').bind(u.id,p.requestId).first<any>();
    }
    if(!order)throw new RequestError('Too many checkout attempts. Try again later.',429);
    if(order.pack!==p.pack||order.purchase_mode!==p.purchaseMode||(p.pack==='noob'&&order.amount_cents!==amount))throw new RequestError('This checkout request was already used. Start a new checkout.',409);
    if(Date.now()-Date.parse(order.created_at)>23*3600e3)throw new RequestError('Checkout expired. Start a new checkout.',409);
    let session;
    if(order.session_id)session=await stripe('checkout/sessions/'+encodeURIComponent(order.session_id));
    else{
      const customer=await customerFor(u);
      const labels:Record<string,string>={smart:'SmarT',nerd:'NeRD',newton:'Newton',alien:'Alien',starter:'Starter',builder:'Builder',scale:'Scale',noob:'Custom'};
      const body=new URLSearchParams({mode:'payment',customer,client_reference_id:order.id,'metadata[order_id]':order.id,'metadata[funding_mode]':order.purchase_mode,'payment_intent_data[metadata][order_id]':order.id,'payment_intent_data[metadata][funding_mode]':order.purchase_mode,'line_items[0][price_data][currency]':order.currency,'line_items[0][price_data][unit_amount]':String(order.amount_cents),'line_items[0][price_data][product_data][name]':`API WILD ${labels[p.pack]} credits`,'line_items[0][price_data][tax_behavior]':'exclusive','line_items[0][quantity]':'1',success_url:config.origin+'/console/billing?session_id={CHECKOUT_SESSION_ID}',cancel_url:config.origin+'/console/billing?cancelled=1','adaptive_pricing[enabled]':'false',integration_identifier:'apiwild-credits-lryhtsez',billing_address_collection:'required','customer_update[address]':'auto','tax_id_collection[enabled]':'true','invoice_creation[enabled]':'true','payment_intent_data[description]':`API WILD ${labels[p.pack]} prepaid credits`});
      // Bind live checkout to the actual catalog products; sandbox remains isolated.
      const products:Record<string,string>={starter:'prod_VDtUuMvZ1o7Q8c',builder:'prod_VDtc162w3pAwhe',scale:'prod_VDtcWkOlH11rgV',noob:'prod_VDtjvX54kp6tMb'};
      const selectedPack=packCatalog.packs.find(pack=>pack.id===p.pack);
      if(selectedPack)body.set('line_items[0][price_data][product_data][name]','API WILD '+selectedPack.name);
      if(config.mode==='live'){
        if(selectedPack&&order.amount_cents===selectedPack.cents){
          // Price IDs are server-owned; browser amounts and Stripe IDs are ignored.
          for(const key of [...body.keys()])if(key.startsWith('line_items[0][price_data]'))body.delete(key);
          body.set('line_items[0][price]',selectedPack.priceId);
        }else{
          body.delete('line_items[0][price_data][product_data][name]');
          body.set('line_items[0][price_data][product]',selectedPack?.productId||products[p.pack]);
        }
      }
      body.set('branding_settings[display_name]','API WILD');
      // Stripe requires updating an existing customer's name when collecting tax IDs.
      body.set('customer_update[name]','auto');
      body.set('custom_text[submit][message]','One-time API WILD usage credits. No automatic renewal. Payment collected by 2740797 Ontario Inc.');
      body.set('payment_intent_data[receipt_email]',identity.email);
      if(config.tax)body.set('automatic_tax[enabled]','true');
      session=await stripe('checkout/sessions',body,'apiwild-order-'+order.id);
      if(typeof session.id!=='string'||!session.id.startsWith('cs_'))throw new RequestError('Invalid checkout response.',502);
      await db.prepare('UPDATE billing_orders SET session_id=?,status=? WHERE id=? AND session_id IS NULL').bind(session.id,'checkout',order.id).run();
    }
    if(session.status!=='open')throw new RequestError('This checkout has completed or expired. Refresh billing to start again.',409);
    if(typeof session.url!=='string'||new URL(session.url).origin!=='https://checkout.stripe.com')throw new RequestError('Checkout link unavailable.',502);
    return respond({url:session.url});
  }catch(e){return respond({error:e instanceof RequestError?e.message:'Checkout could not be started. Please retry.'},e instanceof RequestError?e.status:e instanceof SyntaxError?400:503);}
}
