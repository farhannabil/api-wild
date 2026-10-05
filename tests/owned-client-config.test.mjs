import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedClientConfig,verifiedCheckoutUrl} from '../lib/owned-client-config.mjs';
test('configuration export contains an environment placeholder and approved model only',()=>{const config=ownedClientConfig('model-a',['model-a']);assert.deepEqual(config,{baseURL:'https://apiwild.com/v1',apiKey:'${APIWILD_API_KEY}',model:'model-a'});assert.throws(()=>ownedClientConfig('unapproved',['model-a']));});
test('checkout cannot redirect to an unrelated host or embed credentials',()=>{assert.equal(verifiedCheckoutUrl('https://checkout.stripe.com/c/pay/example'),'https://checkout.stripe.com/c/pay/example');for(const url of ['javascript:alert(1)','https://evil.test/c/pay/x','https://checkout.stripe.com.evil.test/c/pay/x','http://checkout.stripe.com/c/pay/x','https://user@checkout.stripe.com/c/pay/x','https://checkout.stripe.com/not-checkout'])assert.throws(()=>verifiedCheckoutUrl(url));});
