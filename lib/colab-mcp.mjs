import { execFileSync } from 'node:child_process';

export const MCP_URL = 'https://colaboratory.googleapis.com/mcp';

export function getAccessToken(env = process.env) {
  if (env.COLAB_ACCESS_TOKEN?.trim()) return env.COLAB_ACCESS_TOKEN.trim();
  try {
    return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000
    }).trim();
  } catch {
    throw new Error('No Colab OAuth token. Run gcloud auth application-default login or set COLAB_ACCESS_TOKEN.');
  }
}

export function decodeMcpResponse(body, contentType = '') {
  const messages = [];
  if (/text\/event-stream/i.test(contentType) || /^\s*(?:data:|event:|:)/m.test(body)) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { messages.push(JSON.parse(data)); }
      catch { throw new Error(`Malformed MCP SSE event: ${data.slice(0, 160)}`); }
    }
  } else {
    try { messages.push(JSON.parse(body)); }
    catch { throw new Error(`Non-JSON MCP response: ${body.slice(0, 180)}`); }
  }
  const error = messages.find(m => m?.error)?.error;
  if (error) throw new Error(`MCP error ${error.code ?? ''}: ${error.message ?? JSON.stringify(error)}`);
  const terminal = [...messages].reverse().find(m => m?.result !== undefined);
  if (!terminal) throw new Error('MCP response has no terminal result (connection interrupted or deadline exceeded)');
  if (terminal.result?.isError) {
    const summary = terminal.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    throw new Error(`MCP tool failed: ${summary || 'unknown failure'}`);
  }
  const content = terminal.result?.structuredContent;
  if (content !== undefined) return content;
  const text = terminal.result?.content?.find(c => c.type === 'text')?.text;
  if (text !== undefined) {
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return terminal.result;
}

export async function callMcp(name, args = {}, {token, fetchFn = fetch, timeoutMs = 600000} = {}) {
  token ||= getAccessToken();
  const response = await fetchFn(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Colab MCP HTTP ${response.status}: ${body.slice(0, 240)}`);
  return decodeMcpResponse(body, response.headers.get('content-type') || '');
}

export function validateRuntime(name) {
  if (!/^runtimes\/[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('Expected runtime name: runtimes/<runtime-id>');
  return name;
}
export function validateSession(name) {
  if (!/^runtimes\/[a-z0-9][a-z0-9-]{0,62}\/sessions\/[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('Expected session name: runtimes/<runtime-id>/sessions/<session-id>');
  return name;
}
