#!/usr/bin/env node
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../lib/gateway.mjs';
import {Autopilot} from '../lib/autopilot.mjs';
const env=process.env;
const stateFile=env.COLAB_STATE_FILE || join(homedir(),'.config/openclaw-colab/autopilot-state.json');
const idleMinutes=Number(env.COLAB_IDLE_MINUTES || 30);
if (!Number.isFinite(idleMinutes)||idleMinutes<1) throw Error('COLAB_IDLE_MINUTES must be positive');
if (!env.COLAB_GATEWAY_API_KEY) throw Error('COLAB_GATEWAY_API_KEY is required');
if(env.COLAB_DELETE_OWNED_RUNTIME_ON_IDLE!=='yes')throw Error('Set COLAB_DELETE_OWNED_RUNTIME_ON_IDLE=yes to enable Autopilot');
const model=env.COLAB_MODEL || 'qwen3:4b-instruct-2507-q4_K_M';
const autopilot=new Autopilot({stateFile,model});
await autopilot.load();
const gateway=createGateway({
  resolveSession:async()=>autopilot.ensure(),
  model,apiKey:env.COLAB_GATEWAY_API_KEY,
  port:Number(env.COLAB_GATEWAY_PORT||18080),idleMinutes,
  onIdle:()=>autopilot.release()
});
await gateway.start();
process.on('SIGTERM',()=>gateway.shutdown());
process.on('SIGINT',()=>gateway.shutdown());
