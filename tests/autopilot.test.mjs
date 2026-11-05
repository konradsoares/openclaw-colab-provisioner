import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Autopilot,asError,bootstrapCode} from '../lib/autopilot.mjs';
const spec={variant:'VARIANT_GPU',accelerator:'T4',shape:'SHAPE_STANDARD'};
const marker='__AUTOPILOT__=';
test('bootstrapping code prints explicit status and model',()=>{assert.match(bootstrapCode('test:model'),/test:model/);assert.deepEqual(asError({stdout:marker+'{"ready":true}'}),{ready:true});});
test('provision, persist, reuse and release only owned runtime',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-ap-'));
 let created=false,createCount=0,deleteCount=0;
 const calls=[];
 const mcp=async(name,args)=>{
  calls.push(name);
  if(name==='list_runtimes')return {runtimes:created?[{name:'runtimes/r-test123'}]:[]};
  if(name==='list_runtime_specs')return {runtimeSpecs:[{eligible:true,key:spec}]};
  if(name==='create_runtime'){created=true;createCount++;return {metadata:{runtime:'runtimes/r-test123'}};}
  if(name==='create_session')return {name:'runtimes/r-test123/sessions/openclaw-autopilot'};
  if(name==='execute_code')return {stdout:marker+JSON.stringify({ready:true})};
  if(name==='delete_runtime'){assert.equal(args.name,'runtimes/r-test123');deleteCount++;return {};}
  throw Error(name);
 };
 try{
  const a=new Autopilot({mcp,stateFile:join(dir,'state.json'),pollMs:1});await a.load();
  const [one,two]=await Promise.all([a.ensure(),a.ensure()]);assert.equal(one,two);assert.equal(createCount,1);
  const b=new Autopilot({mcp,stateFile:join(dir,'state.json')});await b.load();assert.equal(await b.ensure(),one);assert.equal(createCount,1);
  assert.equal(await b.release(),true);assert.equal(deleteCount,1);assert.equal(await b.release(),false);
  assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).owned,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('does not delete externally-created runtimes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-ap-'));
 try{const a=new Autopilot({stateFile:join(dir,'state.json'),mcp:async()=>{throw Error('No calls expected')}});await a.load();assert.equal(await a.release(),false);}finally{await rm(dir,{recursive:true,force:true});}
});
test('recovers runtime name from list when create returns operation only',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-ap-'));
 let created=false,creates=0;
 const mcp=async(name)=>{
  if(name==='list_runtime_specs')return {runtimeSpecs:[{eligible:true,key:spec}]};
  if(name==='list_runtimes')return {runtimes:created?[{name:'runtimes/r-ops123',runtimeSpec:spec}]:[]};
  if(name==='create_runtime'){created=true;creates++;return {name:'operations/op-abc'};}
  if(name==='create_session')return {name:'runtimes/r-ops123/sessions/openclaw-autopilot'};
  if(name==='execute_code')return {stdout:marker+'{"ready":true}'};
  throw Error(name);
 };
 try {
  const a=new Autopilot({mcp,stateFile:join(dir,'state.json'),pollMs:1});await a.load();
  assert.equal(await a.ensure(),'runtimes/r-ops123/sessions/openclaw-autopilot');
  assert.equal(a.state.runtime,'runtimes/r-ops123');assert.equal(creates,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('refuses duplicate T4 when a runtime is already unmanaged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-ap-'));
 let creates=0;
 const mcp=async(name)=>{
  if(name==='list_runtime_specs')return {runtimeSpecs:[{eligible:true,key:spec}]};
  if(name==='list_runtimes')return {runtimes:[{name:'runtimes/r-orphan',runtimeSpec:spec}]};
  if(name==='create_runtime'){creates++;return {};}
  throw Error(name);
 };
 try{
  const a=new Autopilot({mcp,stateFile:join(dir,'state.json')});await a.load();
  await assert.rejects(a.ensure(),/Unmanaged T4 Standard/);assert.equal(creates,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('idle cleanup clears state if owned runtime disappeared',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-ap-'));
 let deletes=0;
 const f=join(dir,'state.json');
 const mcp=async(name)=>{if(name==='list_runtimes')return {runtimes:[]};if(name==='delete_runtime'){deletes++;return {}; }throw Error(name);};
 try{
  const a=new Autopilot({mcp,stateFile:f});await a.save({owned:true,runtime:'runtimes/r-gone',session:'runtimes/r-gone/sessions/s1',ready:true});
  assert.equal(await a.release(),true);assert.equal(deletes,0);assert.equal(await a.release(),false);
  assert.deepEqual(JSON.parse(await readFile(f,'utf8')),{});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('release clears state on racing NOT_FOUND only after verifying absence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-ap-'));
 let exists=true;
 const mcp=async(name)=>{if(name==='list_runtimes')return {runtimes:exists?[{name:'runtimes/r-gone'}]:[]};if(name==='delete_runtime'){exists=false;throw Error('MCP tool failed: Requested entity was not found.');}throw Error(name);};
 try{const a=new Autopilot({mcp,stateFile:join(dir,'s.json')});await a.save({owned:true,runtime:'runtimes/r-gone'});assert.equal(await a.release(),true);assert.equal(await a.release(),false);}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('recover stale state then provisions new runtime',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-ap-'));let created=false;
 const mcp=async(name)=>{
  if(name==='list_runtimes')return {runtimes:created?[{name:'runtimes/r-new',runtimeSpec:spec}]:[]};
  if(name==='list_runtime_specs')return {runtimeSpecs:[{eligible:true,key:spec}]};
  if(name==='create_runtime'){created=true;return {metadata:{runtime:'runtimes/r-new'}};}
  if(name==='create_session')return {name:'runtimes/r-new/sessions/openclaw-autopilot'};
  if(name==='execute_code')return {stdout:marker+'{"ready":true}'};
  throw Error(name);
 };
 try{const a=new Autopilot({mcp,stateFile:join(dir,'s.json'),pollMs:1});await a.save({owned:true,runtime:'runtimes/r-old',session:'runtimes/r-old/sessions/openclaw-autopilot',ready:true});assert.match(await a.ensure(),/runtimes\/r-new\/sessions/);assert.equal(a.state.runtime,'runtimes/r-new');}
 finally{await rm(dir,{recursive:true,force:true});}
});

test('health probes are cached and do not create a second runtime',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-health-'));
 let time=1,created=0,probes=0,bootstrap=0;
 const mcp=async(name,args)=>{
  if(name==='list_runtimes')return {runtimes:[{name:'runtimes/r-test123',runtimeSpec:spec}]};
  if(name==='execute_code'){
   if(args.code.includes('/api/tags'))probes++;else bootstrap++;
   return {stdout:marker+'{"ready":true}'};
  }
  if(name==='create_runtime'){created++;throw Error('Must reuse runtime');}
  throw Error(name);
 };
 try {
  const a=new Autopilot({mcp,stateFile:join(dir,'state.json'),now:()=>time,healthCheckMs:300000});
  await a.save({owned:true,runtime:'runtimes/r-test123',session:'runtimes/r-test123/sessions/openclaw-autopilot',ready:true});
  await a.ensure();assert.equal(probes,1);
  time=60_000;await a.ensure();assert.equal(probes,1);
  time=301_000;await a.ensure();assert.equal(probes,2);
  assert.equal(created,0);assert.equal(bootstrap,0);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('unhealthy Ollama reboots model in same owned runtime without reprovisioning',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-health-'));
 let created=0,probes=0,bootstraps=0;
 const mcp=async(name,args)=>{
  if(name==='list_runtimes')return {runtimes:[{name:'runtimes/r-test123',runtimeSpec:spec}]};
  if(name==='execute_code'){
   if(args.code.includes('/api/tags')){probes++;return {stdout:marker+'{"ready":false,"error":"offline"}'};}
   bootstraps++;return {stdout:marker+'{"ready":true}'};
  }
  if(name==='create_runtime'){created++;throw Error('Should not provision again');}
  throw Error(name);
 };
 try {
  const a=new Autopilot({mcp,stateFile:join(dir,'state.json'),now:()=>123,healthCheckMs:300000,logger:{log(){}}});
  await a.save({owned:true,runtime:'runtimes/r-test123',session:'runtimes/r-test123/sessions/openclaw-autopilot',ready:true});
  assert.equal(await a.ensure(),'runtimes/r-test123/sessions/openclaw-autopilot');
  assert.equal(probes,1);assert.equal(bootstraps,1);assert.equal(created,0);
  assert.equal(a.state.ready,true);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('missing session recovers inside owned runtime and never creates a second GPU',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-recovery-'));
 let createdRuntime=0,createdSession=0,healthChecks=0,bootstraps=0;
 const mcp=async(name,args)=>{
  if(name==='list_runtimes')return {runtimes:[{name:'runtimes/r-test123',runtimeSpec:spec}]};
  if(name==='create_runtime'){createdRuntime++;throw Error('Unexpected GPU provisioning');}
  if(name==='create_session'){createdSession++;assert.equal(args.parent,'runtimes/r-test123');return {name:'runtimes/r-test123/sessions/oc-recovered'};}
  if(name==='execute_code'){
   if(args.code.includes('/api/tags')){healthChecks++;throw Error('session not found: 404');}
   bootstraps++;assert.equal(args.session,'runtimes/r-test123/sessions/oc-recovered');return {stdout:marker+'{"ready":true}'};
  }
  throw Error('Unexpected call '+name);
 };
 try {
  const a=new Autopilot({mcp,stateFile:join(dir,'state.json'),now:()=>555,logger:{log(){}}});
  await a.save({owned:true,runtime:'runtimes/r-test123',session:'runtimes/r-test123/sessions/old',ready:true});
  assert.equal(await a.ensure(),'runtimes/r-test123/sessions/oc-recovered');
  assert.equal(createdRuntime,0);assert.equal(createdSession,1);assert.equal(healthChecks,1);assert.equal(bootstraps,1);
  assert.equal(a.state.ready,true);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('unrelated model errors never cause session replacement or GPU creation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-recovery-'));let created=0;
 const mcp=async(name)=>{
  if(name==='list_runtimes')return {runtimes:[{name:'runtimes/r-test123',runtimeSpec:spec}]};
  if(name==='execute_code')throw Error('GPU quota unavailable');
  if(name==='create_runtime'||name==='create_session'){created++;throw Error('unexpected');}
  throw Error(name);
 };
 try {
  const a=new Autopilot({mcp,stateFile:join(dir,'state.json'),logger:{log(){}}});
  await a.save({owned:true,runtime:'runtimes/r-test123',session:'runtimes/r-test123/sessions/old',ready:true});
  await assert.rejects(a.ensure(),/GPU quota unavailable/);
  assert.equal(created,0);assert.equal(a.state.session,'runtimes/r-test123/sessions/old');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('runtime visibility checks existing, missing and absent without provisioning',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'colab-visible-'));
 let listed=true,calls=[];
 const mcp=async(name)=>{
  calls.push(name);
  if(name==='list_runtimes')return {runtimes:listed?[{name:'runtimes/r-test123'}]:[]};
  throw Error('Status probe must not call '+name);
 };
 try{
  const a=new Autopilot({mcp,stateFile:join(dir,'state.json')});
  assert.deepEqual(await a.runtimeStatus(),{status:'absent',runtime:null});
  await a.save({owned:true,runtime:'runtimes/r-test123',session:'runtimes/r-test123/sessions/known',ready:true});
  assert.deepEqual(await a.runtimeStatus(),{status:'existing',runtime:'runtimes/r-test123'});
  listed=false;
  assert.deepEqual(await a.runtimeStatus(),{status:'missing',runtime:'runtimes/r-test123'});
  assert.equal(a.state.runtime,'runtimes/r-test123');
  assert.deepEqual(calls,['list_runtimes','list_runtimes']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
