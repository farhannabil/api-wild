// Configuration exports deliberately never accept or include an API secret.
export function ownedClientConfig(model, approvedModels){
 if(typeof model!=='string'||!Array.isArray(approvedModels)||!approvedModels.includes(model))throw Error('Choose an approved model for the configuration.');
 return {baseURL:'https://apiwild.com/v1',apiKey:'${APIWILD_API_KEY}',model};
}
export function verifiedCheckoutUrl(value){
 let url;try{url=new URL(value)}catch{throw Error('The secure checkout URL could not be verified.')}
 if(url.origin!=='https://checkout.stripe.com'||url.username||url.password||!url.pathname.startsWith('/c/'))throw Error('The secure checkout URL could not be verified.');
 return url.href;
}
