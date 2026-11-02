#!/usr/bin/env node
import { createGateway } from '../lib/gateway.mjs';
const session=process.env.COLAB_SESSION;
if (!session) { console.error('Missing COLAB_SESSION (runtimes/ID/sessions/ID)'); process.exit(2); }
const idleMinutes=Number(process.env.COLAB_IDLE_MINUTES || 0);
if (!Number.isFinite(idleMinutes) || idleMinutes<0) { console.error('Invalid COLAB_IDLE_MINUTES'); process.exit(2); }
const gateway=createGateway({session,model:process.env.COLAB_MODEL || 'qwen3:4b-instruct-2507-q4_K_M',apiKey:process.env.COLAB_GATEWAY_API_KEY || '',port:Number(process.env.COLAB_GATEWAY_PORT || 18080),host:'127.0.0.1',idleMinutes,confirmOwnedRuntime:process.env.COLAB_DELETE_OWNED_RUNTIME_ON_IDLE==='yes'});
await gateway.start();
process.on('SIGINT',()=>gateway.shutdown());
process.on('SIGTERM',()=>gateway.shutdown());
