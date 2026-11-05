import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway,validateChat,makePython,parseExecution,formatAssistant} from '../lib/gateway.mjs';

const session='runtimes/r-test/sessions/smart-router';
test('validates messages and unsupported streaming',()=>{
  assert.equal(validateChat({model:'colab-t4',messages:[{role:'user',content:'hi'}]}).model,'qwen3:4b-instruct-2507-q4_K_M');
  assert.equal(validateChat({messages:[{role:'user',content:'hi'}],stream:true}).stream,false);
  assert.throws(()=>validateChat({messages:[{role:'user',content:'hi'}],tools:[{}]}),/function tools/);
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

test('adapts OpenAI tool definitions and historical tool result to Ollama',()=>{
 const tool={type:'function',function:{name:'lookup',description:'Find item',parameters:{type:'object',properties:{term:{type:'string'}}}}};
 const payload=validateChat({model:'colab-t4',stream:false,tools:[tool],messages:[
  {role:'user',content:'look up'},
  {role:'assistant',content:null,tool_calls:[{id:'call_one',type:'function',function:{name:'lookup',arguments:'{"term":"abc"}'}}]},
  {role:'tool',tool_call_id:'call_one',content:'found abc'}
 ]});
 assert.equal(payload.tools[0].function.name,'lookup');
 assert.deepEqual(payload.messages[1].tool_calls[0].function.arguments,{term:'abc'});
 assert.deepEqual(payload.messages[2],{role:'tool',content:'found abc',tool_name:'lookup'});
 assert.ok(!JSON.stringify(payload).includes('call_one'));
});
test('rejects unknown tool call IDs, malformed arguments, and unsupported tool_choice',()=>{
 const msgs=[{role:'user',content:'test'}];
 assert.throws(()=>validateChat({messages:[...msgs,{role:'tool',content:'x',tool_call_id:'missing'}]}),/Unknown tool_call_id/);
 assert.throws(()=>validateChat({messages:[{role:'assistant',content:null,tool_calls:[{id:'x',type:'function',function:{name:'lookup',arguments:'not-json'}}]}]}),/Invalid tool arguments JSON/);
 assert.throws(()=>validateChat({messages:msgs,tool_choice:'required'}),/tool_choice/);
 assert.equal(validateChat({messages:msgs,tools:[],tool_choice:'none'}).tools,undefined);
});
test('returns OpenAI tool_calls and executes no tools inside gateway',async()=>{
 const seen=[];
 const fake=async(name,args)=>{
  seen.push({name,args});
  const payload=JSON.parse(Buffer.from(args.code.match(/b64decode\('([^']+)'\)/)[1],'base64').toString());
  const response=payload.messages.some(m=>m.role==='tool')
   ? {message:{role:'assistant',content:'The answer is 7'},done_reason:'stop'}
   : {message:{role:'assistant',content:'',tool_calls:[{function:{name:'lookup',arguments:{value:7}}}]},done_reason:'stop'};
  return {stdout:'__COLAB_GATEWAY_RESULT__='+JSON.stringify({ok:true,data:response})};
 };
 const gateway=createGateway({session,port:0,mcpCall:fake,logger:{log(){},error(){}}});
 const server=await gateway.start();
 const url='http://127.0.0.1:'+server.address().port+'/v1/chat/completions';
 const tool={type:'function',function:{name:'lookup',parameters:{type:'object',properties:{value:{type:'number'}}}}};
 const post=async body=>{const resp=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:resp.status,data:await resp.json()};};
 try {
  const first=await post({model:'colab-t4',tools:[tool],messages:[{role:'user',content:'look up 7'}]});
  assert.equal(first.status,200);
  assert.equal(first.data.choices[0].finish_reason,'tool_calls');
  const call=first.data.choices[0].message.tool_calls[0];
  assert.match(call.id,/^call_/);
  assert.equal(call.function.name,'lookup');
  assert.deepEqual(JSON.parse(call.function.arguments),{value:7});
  const second=await post({model:'colab-t4',tools:[tool],messages:[{role:'user',content:'look up 7'},first.data.choices[0].message,{role:'tool',tool_call_id:call.id,content:'7'}]});
  assert.equal(second.status,200);
  assert.equal(second.data.choices[0].message.content,'The answer is 7');
  assert.equal(seen.length,2);
  assert.equal(seen[0].name,'execute_code');
  assert.equal(seen[1].name,'execute_code');
 } finally {await gateway.shutdown();}
});

test('configurable Ollama context matches OpenClaw staging profile',()=>{ const prev=process.env.COLAB_NUM_CTX; try {process.env.COLAB_NUM_CTX='32768'; assert.equal(validateChat({messages:[{role:'user',content:'hi'}]}).options.num_ctx,32768);process.env.COLAB_NUM_CTX='99999';assert.throws(()=>validateChat({messages:[{role:'user',content:'hi'}]}),/COLAB_NUM_CTX/);} finally {if(prev===undefined) delete process.env.COLAB_NUM_CTX;else process.env.COLAB_NUM_CTX=prev;}});

test('streams OpenAI-compatible SSE chunks with final stop and DONE',async()=>{
 const gateway=createGateway({session,port:0,mcpCall:async()=>({stdout:'__COLAB_GATEWAY_RESULT__='+JSON.stringify({ok:true,data:{message:{role:'assistant',content:'hello'},prompt_eval_count:1,eval_count:2}})}),logger:{log(){},error(){}}});
 const server=await gateway.start();
 try {
  const url='http://127.0.0.1:'+server.address().port+'/v1/chat/completions';
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stream:true,stream_options:{include_usage:true},messages:[{role:'user',content:'hi'}]})});
  assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/event-stream/);
  const text=await res.text();
  assert.match(text,/data: \[DONE\]/);
  const events=text.split('\n\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
  assert.equal(events[0].choices[0].delta.role,'assistant');
  assert.ok(events.some(x=>x.choices[0]?.delta?.content==='hello'));
  assert.ok(events.some(x=>x.choices[0]?.finish_reason==='stop'));
  assert.ok(events.some(x=>x.choices.length===0 && x.usage.total_tokens===3));
 } finally {await gateway.shutdown();}
});
test('SSE returns tool_calls compatible with OpenAI streaming',async()=>{
 const result={message:{role:'assistant',content:'',tool_calls:[{function:{name:'lookup',arguments:{term:'foo'}}}]}};
 const gateway=createGateway({session,port:0,mcpCall:async()=>({stdout:'__COLAB_GATEWAY_RESULT__='+JSON.stringify({ok:true,data:result})}),logger:{log(){},error(){}}});
 const server=await gateway.start();
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stream:true,messages:[{role:'user',content:'search'}],tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}]})});
  assert.equal(response.status,200);
  const events=(await response.text()).split('\n\n').filter(s=>s.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
  const call=events.find(x=>x.choices[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
  assert.equal(call.function.name,'lookup');assert.equal(JSON.parse(call.function.arguments).term,'foo');
  assert.ok(events.some(x=>x.choices[0]?.finish_reason==='tool_calls'));
 }finally{await gateway.shutdown();}
});

test('accepts structured OpenAI text-only content and rejects non-text blocks',()=>{
 const payload=validateChat({messages:[{role:'user',content:[{type:'text',text:'hello'},{type:'input_text',text:'world'}]}]});
 assert.equal(payload.messages[0].content,'hello\nworld');
 assert.throws(()=>validateChat({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://invalid'}}]}]}),/Only structured text parts/);
});

test('runtime status endpoint is authenticated, read-only and does not reset idle timeout',async()=>{
 let clock=0,tick,releases=0,probes=0;
 const g=createGateway({
  session,port:0,apiKey:'secret',idleMinutes:30,
  now:()=>clock,scheduleInterval:fn=>{tick=fn;return {unref(){}};},cancelInterval:()=>{},
  runtimeStatus:async()=>{probes++;return {status:'existing',runtime:'runtimes/r-test'};},
  onIdle:async()=>{releases++;},
  logger:{log(){},error(){}}
 });
 const srv=await g.start();
 const url='http://127.0.0.1:'+srv.address().port+'/v1/runtime-status';
 try{
  assert.equal((await fetch(url)).status,401);
  clock=29*60_000;
  const response=await fetch(url,{headers:{authorization:'Bearer secret'}});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:'existing',runtime:'runtimes/r-test'});
  assert.equal(probes,1);
  clock=30*60_000;
  await tick();
  assert.equal(releases,1);
  assert.equal(g.stats.requests,0);
 }finally{await g.shutdown();}
});
