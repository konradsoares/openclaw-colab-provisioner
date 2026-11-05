import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { callMcp, validateSession, validateRuntime } from './colab-mcp.mjs';

const DEFAULT_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
const MARKER = '__COLAB_GATEWAY_RESULT__=';
export const DEFAULT_PORT = 18080;

const error = (message, status = 400, type = 'invalid_request_error') => Object.assign(new Error(message), {status, type});
const isPlain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateChat(body, model = DEFAULT_MODEL) {
  if (!isPlain(body)) throw error('JSON object required');
  if (body.stream !== false && body.stream !== undefined) throw error('Streaming is not supported by the MCP gateway yet');
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100) throw error('messages must contain 1-100 messages');
  if (body.functions || body.response_format || body.audio || body.modalities) throw error('Legacy functions, multimodal content and structured outputs are not supported yet');
  if (body.tool_choice !== undefined && !['auto','none'].includes(body.tool_choice)) throw error('Only tool_choice auto/none supported; required and named choices are not enforceable by Ollama');
  const toolIds = new Map();
  const messages = body.messages.map(m => {
    if (!isPlain(m) || !['system','user','assistant','tool'].includes(m.role)) throw error('Unsupported message role');
    if (m.content !== undefined && m.content !== null && typeof m.content !== 'string') throw error('Only text content is supported');
    const content = m.content ?? '';
    if (content.length > 100000) throw error('Message too long');
    if (m.role === 'assistant' && m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls) || !m.tool_calls.length || m.tool_calls.length > 20) throw error('Invalid assistant tool_calls');
      const calls = m.tool_calls.map(c => {
        if (!isPlain(c) || c.type !== 'function' || !isPlain(c.function) || typeof c.id !== 'string' || !c.id || c.id.length > 128) throw error('Invalid assistant tool call');
        const f=c.function;
        if (typeof f.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/.test(f.name)) throw error('Invalid tool function name');
        let args=f.arguments;
        if (typeof args === 'string') {try {args=JSON.parse(args);} catch {throw error('Invalid tool arguments JSON');}}
        if (!isPlain(args)) throw error('Tool arguments must be a JSON object');
        if (toolIds.has(c.id)) throw error('Duplicate tool call id');
        toolIds.set(c.id,f.name);
        return {function:{name:f.name,arguments:args}};
      });
      return {role:'assistant',content,tool_calls:calls};
    }
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !toolIds.has(m.tool_call_id)) throw error('Unknown tool_call_id in history');
      return {role:'tool',content,tool_name:toolIds.get(m.tool_call_id)};
    }
    if (m.content === null && m.role !== 'assistant') throw error('Only assistant messages may have null content');
    return {role:m.role,content};
  });
  let tools;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 32) throw error('tools must be an array of at most 32 functions');
    tools=body.tools.map(t => {
      if (!isPlain(t) || t.type !== 'function' || !isPlain(t.function)) throw error('Only function tools supported');
      const f=t.function;
      if (typeof f.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/.test(f.name) || !isPlain(f.parameters)) throw error('Invalid tool definition');
      if (f.description !== undefined && typeof f.description !== 'string') throw error('Invalid tool description');
      return {type:'function',function:{name:f.name,...(f.description ? {description:f.description}:{}),parameters:f.parameters}};
    });
  }
  if (body.n !== undefined && body.n !== 1) throw error('Only n=1 is supported');
  if (body.model !== undefined && body.model !== model && body.model !== 'colab-t4') throw error('Unsupported model: '+body.model,404);
  const options = {num_ctx:4096};
  for (const [key,target] of [['temperature','temperature'],['top_p','top_p'],['seed','seed'],['max_tokens','num_predict']]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) throw error(key+' must be numeric');
      options[target] = body[key];
    }
  }
  if (options.temperature !== undefined && (options.temperature < 0 || options.temperature > 2)) throw error('temperature must be 0-2');
  if (options.top_p !== undefined && (options.top_p < 0 || options.top_p > 1)) throw error('top_p must be 0-1');
  if (options.num_predict !== undefined && (!Number.isInteger(options.num_predict) || options.num_predict < 1 || options.num_predict > 8192)) throw error('max_tokens must be an integer 1-8192');
  return {model,messages,stream:false,keep_alive:'15m',options,...(tools && body.tool_choice !== 'none' ? {tools}:{})};
}
export function formatAssistant(message) {
  if (!isPlain(message) || typeof message.content !== 'string') throw error('Invalid Ollama assistant response',502,'upstream_error');
  if (message.tool_calls === undefined || message.tool_calls.length === 0) return {role:'assistant',content:message.content};
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 20) throw error('Invalid Ollama tool calls',502,'upstream_error');
  const calls=message.tool_calls.map(call => {
    const f=call?.function;
    if (!isPlain(f) || typeof f.name !== 'string' || !isPlain(f.arguments)) throw error('Malformed Ollama tool call',502,'upstream_error');
    return {id:'call_'+randomUUID().replaceAll('-',''),type:'function',function:{name:f.name,arguments:JSON.stringify(f.arguments)}};
  });
  return {role:'assistant',content:message.content,tool_calls:calls};
}
export function makePython(payload) {
  const input = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `import base64,json,urllib.request,urllib.error\ntry:\n p=json.loads(base64.b64decode('${input}'))\n req=urllib.request.Request('http://127.0.0.1:11434/api/chat',data=json.dumps(p).encode(),headers={'Content-Type':'application/json'})\n with urllib.request.urlopen(req,timeout=480) as r: result=json.load(r)\n print('${MARKER}'+json.dumps({'ok':True,'data':result},ensure_ascii=False))\nexcept Exception as e:\n print('${MARKER}'+json.dumps({'ok':False,'error':str(e)},ensure_ascii=False))\n`;
}
export function parseExecution(result) {
  if (result.executionError) throw error(`Colab Python error: ${result.executionError.value}`, 502, 'upstream_error');
  if (result.outputTruncated) throw error('Colab truncated execution output', 502, 'upstream_error');
  const stdout = result.stdout || '';
  const line = stdout.split(/\r?\n/).reverse().find(x => x.startsWith(MARKER));
  if (!line) throw error(`Colab did not return Ollama response: ${(result.stderr || stdout).slice(-250)}`,502,'upstream_error');
  let packet;
  try { packet = JSON.parse(line.slice(MARKER.length)); } catch { throw error('Invalid Ollama response from Colab',502,'upstream_error'); }
  if (!packet.ok) throw error(`Ollama on Colab: ${packet.error}`,502,'upstream_error');
  if (!packet.data?.message || typeof packet.data.message.content !== 'string') throw error('Missing Ollama completion',502,'upstream_error');
  return packet.data;
}
function writeJson(res, status, value) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}
export function createGateway({session, model=DEFAULT_MODEL, apiKey='', port=DEFAULT_PORT, host='127.0.0.1', idleMinutes=0, confirmOwnedRuntime=false, mcpCall=callMcp, resolveSession=null, onIdle=null, logger=console, now=Date.now, scheduleInterval=setInterval, cancelInterval=clearInterval}={}) {
  if (!resolveSession) validateSession(session);
  const runtime = session ? validateRuntime(session.split('/sessions/')[0]) : null;
  let pending = Promise.resolve(), inFlight = 0, lastActivity = now(), stopped = false, cleanupTriggered = false;
  const stats = {requests:0, failures:0};
  async function complete(payload) {
    const activeSession = resolveSession ? await resolveSession() : session;
    validateSession(activeSession);
    const execution = await mcpCall('execute_code', {session:activeSession, code:makePython(payload), executionId:randomUUID()}, {timeoutMs:600000});
    return parseExecution(execution);
  }
  function enqueue(job) {
    inFlight++;
    const work = pending.then(job);
    pending = work.catch(() => {}).finally(() => {inFlight--; lastActivity=now();});
    return work;
  }
  const server = http.createServer(async (req,res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) return writeJson(res,401,{error:{message:'Unauthorized',type:'authentication_error'}});
    if (req.method === 'GET' && path === '/healthz') return writeJson(res,200,{status:'ok', backend:'colab-mcp', runtime, inFlight});
    if (req.method === 'GET' && path === '/v1/models') return writeJson(res,200,{object:'list',data:[{id:'colab-t4',object:'model',created:0,owned_by:'colab',real_model:model}]});
    if (req.method !== 'POST' || path !== '/v1/chat/completions') return writeJson(res,404,{error:{message:'Not found',type:'invalid_request_error'}});
    let raw='';
    try {
      for await (const chunk of req) {
        raw+=chunk;
        if (raw.length > 1_000_000) throw error('Request body too large',413);
      }
      const payload=validateChat(JSON.parse(raw),model);
      lastActivity=now(); // Only valid, authenticated chat requests reset idle time.
      const started=now();
      stats.requests++;
      const data=await enqueue(() => complete(payload));
      writeJson(res,200,{
        id:`chatcmpl-${randomUUID()}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:'colab-t4',
        choices:[{index:0,message:formatAssistant(data.message),finish_reason:data.done_reason==='length'?'length':data.message.tool_calls?.length?'tool_calls':'stop'}],
        usage:{prompt_tokens:data.prompt_eval_count??0,completion_tokens:data.eval_count??0,total_tokens:(data.prompt_eval_count??0)+(data.eval_count??0)},
        gateway:{elapsed_ms:now()-started,ollama_total_ms:Math.round((data.total_duration??0)/1e6)}
      });
    } catch(e) {
      stats.failures++;
      const status=e.status || (e instanceof SyntaxError?400:502);
      logger.error(`Gateway request failed: ${e.message}`);
      writeJson(res,status,{error:{message:e.message,type:e.type || 'upstream_error'}});
    }
  });
  let idleTimer;
  const shutdown = async ({deleteRuntime=false}={}) => {
    if (stopped) return;
    stopped=true;
    cancelInterval(idleTimer);
    if (deleteRuntime && idleMinutes > 0 && confirmOwnedRuntime && !cleanupTriggered && inFlight === 0) {
      cleanupTriggered=true;
      try { await mcpCall('delete_runtime',{name:runtime}); logger.log(`Released idle runtime ${runtime}`); }
      catch(e) {logger.error(`Failed to delete runtime: ${e.message}`);}
    }
    server.close();
  };
  function start() {
    return new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,host,()=>{
        server.off('error',reject);
        logger.log(`Colab gateway listening on http://${host}:${server.address().port} model=colab-t4`);
        resolve(server);
      });
      if (idleMinutes>0 && (confirmOwnedRuntime || onIdle)) {
        idleTimer=scheduleInterval(async()=>{
          if (stopped || inFlight>0 || now()-lastActivity<idleMinutes*60_000) return;
          if (onIdle) {
            try { await onIdle(); lastActivity=now(); } catch(e) {logger.error(`Idle cleanup failed: ${e.message}`); lastActivity=now();}
          } else await shutdown({deleteRuntime:true});
        },10000);
        idleTimer.unref();
      }
    });
  }
  return {server,start,shutdown,stats};
}
