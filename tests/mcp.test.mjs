import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeMcpResponse, callMcp, validateRuntime, validateSession} from '../lib/colab-mcp.mjs';

test('JSON structuredContent', () => {
  assert.equal(decodeMcpResponse(JSON.stringify({result:{structuredContent:{stdout:'ok'}}})).stdout, 'ok');
});
test('SSE notification and terminal event', () => {
  const raw = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"stdout":"Tesla T4"}}}\n\n';
  assert.equal(decodeMcpResponse(raw, 'text/event-stream').stdout, 'Tesla T4');
});
test('tool errors are surfaced', () => {
  assert.throws(() => decodeMcpResponse('{"result":{"isError":true,"content":[{"type":"text","text":"failure"}]}}'), /failure/);
});
test('validates resource names', () => {
  assert.equal(validateRuntime('runtimes/r-test'), 'runtimes/r-test');
  assert.equal(validateSession('runtimes/r-test/sessions/session-1'), 'runtimes/r-test/sessions/session-1');
  assert.throws(() => validateSession('runtimes/a'));
});
test('request uses auth and correct tool', async () => {
  const fetchFn = async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer fake');
    assert.equal(JSON.parse(opts.body).params.name, 'list_sessions');
    return new Response('{"result":{"structuredContent":{"sessions":[]}}}', {headers:{'Content-Type':'application/json'}});
  };
  assert.deepEqual(await callMcp('list_sessions', {parent:'runtimes/r-test'}, {token:'fake', fetchFn}), {sessions:[]});
});
