import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway,validateChat,makePython,parseExecution} from '../lib/gateway.mjs';

const session='runtimes/r-test/sessions/smart-router';
test('validates messages and unsupported streaming',()=>{
  assert.equal(validateChat({model:'colab-t4',messages:[{role:'user',content:'hi'}]}).model,'qwen3:4b-instruct-2507-q4_K_M');
  assert.throws(()=>validateChat({messages:[{role:'user',content:'hi'}],stream:true}),/Streaming/);
  assert.throws(()=>validateChat({messages:[{role:'user',content:'hi'}],tools:[{}]}),/Tool calling/);
});
test('embeds safe base64 payload, no direct Python interpolation',()=>{
  const c=makePython({messages:[{role:'user',content:"');import os;#"}]});
  assert.ok(!c.includes('import os'));
});
test('parses result and detects python errors',()=>{
  const data={message:{role:'assistant',content:'Hello'},eval_count:2};
  assert.equal(parseExecution({stdout:`__COLAB_GATEWAY_RESULT__=${JSON.stringify({ok:true,data})}\n`}).message.content,'Hello');
  assert.throws(()=>parseExecution({executionError:{value:'bad'}}),/bad/);
});
test('serves OpenAI-compatible response and serializes calls',async()=>{
  let concurrent=0,max=0;
  const calls=[];
  const fake=async(name,args)=>{
    calls.push(name);
    if(name==='execute_code') {
      concurrent++;max=Math.max(max,concurrent);
      await new Promise(r=>setTimeout(r,25));concurrent--;
      return {stdout:`__COLAB_GATEWAY_RESULT__=${JSON.stringify({ok:true,data:{message:{role:'assistant',content:'Done'},eval_count:3,prompt_eval_count:4,total_duration:123456789}})}\n`};
    }
    return {};
  };
  const gateway=createGateway({session,port:0,apiKey:'test-key',mcpCall:fake,logger:{log(){},error(){}}});
  const server=await gateway.start();
  const base=`http://127.0.0.1:${server.address().port}`;
  const req=()=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer test-key','content-type':'application/json'},body:JSON.stringify({model:'colab-t4',messages:[{role:'user',content:'hello'}]})});
  try {
    assert.equal((await fetch(`${base}/healthz`)).status,401);
    const [r1,r2]=await Promise.all([req(),req()]);
    assert.equal(r1.status,200);
    assert.equal(r2.status,200);
    assert.equal((await r1.json()).choices[0].message.content,'Done');
    assert.equal(max,1);
    assert.equal(calls.filter(x=>x==='execute_code').length,2);
  } finally { await gateway.shutdown(); }
});
test('idle off does not delete GPU on shutdown',async()=>{
  const calls=[];
  const g=createGateway({session,port:0,mcpCall:async(n)=>{calls.push(n);return {}},logger:{log(){},error(){}}});
  await g.start();await g.shutdown();
  assert.deepEqual(calls,[]);
});
