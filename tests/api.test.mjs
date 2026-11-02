import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRuntimeName,maskSecrets,validateSpec,callApi} from '../lib/colab-api.mjs';
test('valid runtime name',()=>assert.equal(assertRuntimeName('runtimes/abc-12'),'runtimes/abc-12'));
test('reject dangerous runtime names',()=>{for(const n of ['runtimes/../x','runtimes/X','other/test'])assert.throws(()=>assertRuntimeName(n));});
test('redacts connection secrets',()=>assert.deepEqual(maskSecrets({connectionInfo:{token:'secret',url:'https://x'},accessToken:'x'}),{connectionInfo:{token:'[REDACTED]',url:'https://x'},accessToken:'[REDACTED]'}));
test('checks runtime eligibility',()=>{const s={variant:'VARIANT_GPU',accelerator:'T4',shape:'SHAPE_STANDARD'};assert.equal(validateSpec(s,[{eligible:true,key:s}]),s);assert.throws(()=>validateSpec(s,[{eligible:false,key:s}]));});
test('requires token',async()=>await assert.rejects(()=>callApi('/runtimes',{token:''}),/missing/));
test('proper API path and token',async()=>{
 let url='',auth='';const r=await callApi('/runtimes',{token:'fake',fetchImpl:async(u,opt)=>{url=u;auth=opt.headers.Authorization;return {ok:true,json:async()=>({runtimes:[]})};}});
 assert.match(url,/colaboratory.googleapis.com\/v1beta\/runtimes$/);assert.equal(auth,'Bearer fake');assert.deepEqual(r,{runtimes:[]});
});
