#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { callMcp, validateRuntime, validateSession } from '../lib/colab-mcp.mjs';

const [command, ...argv] = process.argv.slice(2);
const HELP = `colabmcp - Google Colab MCP companion CLI (v1.1)

  colabmcp runtimes
  colabmcp gpu status
  colabmcp session create <runtimes/id> [session-id]
  colabmcp session list <runtimes/id>
  colabmcp session delete <runtimes/id/sessions/id> --confirm
  colabmcp exec <runtimes/id/sessions/id> --code 'print(1+1)'
  colabmcp exec <runtimes/id/sessions/id> --file script.py
  colabmcp exec <runtimes/id/sessions/id> --code '...' --json

Auth: COLAB_ACCESS_TOKEN or gcloud application-default credentials.
This tool does not automatically create/delete runtimes or install models.
`;
function option(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (!argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`${name} requires a value`);
  return argv[i+1];
}
function print(value) { console.log(JSON.stringify(value, null, 2)); }
async function main() {
  if (!command || ['help', '-h', '--help'].includes(command)) return console.log(HELP);
  if (command === 'runtimes') return print(await callMcp('list_runtimes'));
  if (command === 'gpu' && argv[0] === 'status') {
    const result = await callMcp('list_runtimes');
    return print({count: result.runtimes?.length ?? 0, runtimes: (result.runtimes || []).map(r => ({name: r.name, spec: r.runtimeSpec}))});
  }
  if (command === 'session') {
    const [action, name, id] = argv;
    if (action === 'create') {
      validateRuntime(name);
      if (id && !/^[a-z][a-z0-9-]{0,62}$/.test(id)) throw new Error('Invalid session id');
      return print(await callMcp('create_session', {parent: name, ...(id ? {sessionId: id} : {})}));
    }
    if (action === 'list') return print(await callMcp('list_sessions', {parent: validateRuntime(name)}));
    if (action === 'delete') {
      validateSession(name);
      if (!argv.includes('--confirm')) throw new Error('Session deletion requires --confirm');
      return print(await callMcp('delete_session', {name}));
    }
  }
  if (command === 'exec') {
    const session = validateSession(argv[0]);
    const codeArg = option('--code');
    const fileArg = option('--file');
    if ((codeArg === undefined) === (fileArg === undefined)) throw new Error('Supply exactly one of --code or --file');
    const code = fileArg === undefined ? codeArg : readFileSync(fileArg, 'utf8');
    const result = await callMcp('execute_code', {session, code, executionId: crypto.randomUUID()});
    if (argv.includes('--json')) return print(result);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.result) process.stdout.write(result.result + '\n');
    if (result.outputTruncated) console.error('WARNING: output truncated by Colab');
    if (result.executionError) {
      console.error(`Python ${result.executionError.name}: ${result.executionError.value}`);
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(`Unknown command: ${[command, ...argv].join(' ')}\n\n${HELP}`);
}
main().catch(error => { console.error('ERROR:', error.message); process.exitCode = 1; });
