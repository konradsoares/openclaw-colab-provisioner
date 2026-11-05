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

test('unauthorized requests and health checks do not extend runtime idle timeout', async()=>{
  let clock=0,tick;
  let releases=0;
  const g=createGateway({
    session,port:0,apiKey:'secret',idleMinutes:30,
    now:()=>clock,
    scheduleInterval:fn=>{tick=fn;return {unref(){}};},
    cancelInterval:()=>{},
    onIdle:async()=>{releases++;},
    mcpCall:async()=>({stdout:'__COLAB_GATEWAY_RESULT__={"ok":true,"data":{"message":{"role":"assistant","content":"ok"}}}'}),
    logger:{log(){},error(){}}
  });
  const server=await g.start();
  const base='http://127.0.0.1:'+server.address().port;
  try {
    clock=29*60_000;
    assert.equal((await fetch(base+'/healthz')).status,401);
    assert.equal((await fetch(base+'/healthz',{headers:{authorization:'Bearer secret'}})).status,200);
    assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST'})).status,401);
    clock=30*60_000;
    await tick();
    assert.equal(releases,1);
  } finally {await g.shutdown();}
});

test('valid chat requests reset idle clock and active requests block cleanup', async()=>{
  let clock=0,tick,releases=0,resolveCall;
  const waitForModel=new Promise(resolve=>resolveCall=resolve);
  const g=createGateway({
    session,port:0,apiKey:'secret',idleMinutes:30,now:()=>clock,
    scheduleInterval:fn=>{tick=fn;return {unref(){}};},cancelInterval:()=>{},
    onIdle:async()=>{releases++;},
    mcpCall:async()=>{await waitForModel;return {stdout:'__COLAB_GATEWAY_RESULT__={"ok":true,"data":{"message":{"role":"assistant","content":"ok"}}}'};},
    logger:{log(){},error(){}}
  });
  const server=await g.start();
  const base='http://127.0.0.1:'+server.address().port;
  try {
    clock=25*60_000;
    const request=fetch(base+'/v1/chat/completions',{
      method:'POST',headers:{authorization:'Bearer secret','content-type':'application/json'},
      body:JSON.stringify({messages:[{role:'user',content:'hello'}]})
    });
    // Wait for the gateway to accept and enqueue the request.
    for(let i=0;i<50 && !g.stats.requests;i++) await new Promise(r=>setTimeout(r,1));
    assert.equal(g.stats.requests,1);
    clock=40*60_000;
    await tick();
    assert.equal(releases,0,'in-flight request must prevent release');
    resolveCall();
    assert.equal((await request).status,200);
    await new Promise(r=>setImmediate(r));
    clock=69*60_000;
    await tick();
    assert.equal(releases,0,'last completed request resets idle clock');
    clock=71*60_000;
    await tick();
    assert.equal(releases,1);
  } finally {resolveCall();await g.shutdown();}
});
