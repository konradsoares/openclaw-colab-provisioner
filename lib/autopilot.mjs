import {callMcp} from './colab-mcp.mjs';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SPEC={variant:'VARIANT_GPU',accelerator:'T4',shape:'SHAPE_STANDARD'};
const marker='__AUTOPILOT__=';
const asError=x=>{if(x?.executionError)throw Error(`Python: ${x.executionError.value}`);if(x?.outputTruncated)throw Error('Output truncated');const line=(x?.stdout||'').split(/\r?\n/).findLast(l=>l.startsWith(marker));if(!line)throw Error(`Missing bootstrap result: ${(x?.stderr||x?.stdout||'').slice(-400)}`);return JSON.parse(line.slice(marker.length));};
const python=`import os,subprocess,time,urllib.request,json,shutil
try:
 model=os.environ.get('COLAB_AUTOPILOT_MODEL','qwen3:4b-instruct-2507-q4_K_M')
 if not shutil.which('zstd'):
  p=subprocess.run(['apt-get','update','-qq'],capture_output=True,text=True,timeout=180)
  if p.returncode: raise RuntimeError('apt-get update: '+p.stderr[-350:])
  p=subprocess.run(['apt-get','install','-y','-qq','zstd'],capture_output=True,text=True,timeout=180)
  if p.returncode: raise RuntimeError('zstd install: '+p.stderr[-350:])
 if not shutil.which('ollama'):
  p=subprocess.run(['bash','-o','pipefail','-c','curl -fsSL https://ollama.com/install.sh | sh'],capture_output=True,text=True,timeout=240)
  if p.returncode: raise RuntimeError('Ollama install: '+(p.stdout+p.stderr)[-450:])
 try: urllib.request.urlopen('http://127.0.0.1:11434/api/version',timeout=2)
 except Exception:
  log=open('/tmp/colab-ollama-serve.log','a')
  subprocess.Popen(['ollama','serve'],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'OLLAMA_HOST':'127.0.0.1:11434'})
  log.close()
  for _ in range(30):
   try: urllib.request.urlopen('http://127.0.0.1:11434/api/version',timeout=2);break
   except Exception: time.sleep(1)
  else: raise RuntimeError('ollama serve not ready')
 p=subprocess.run(['ollama','pull',model],capture_output=True,text=True,timeout=540)
 if p.returncode: raise RuntimeError('model pull: '+(p.stdout+p.stderr)[-450:])
 print('${marker}'+json.dumps({'ready':True,'model':model}))
except Exception as e:
 print('${marker}'+json.dumps({'ready':False,'error':str(e)}))
`;
function bootstrapCode(model){return `import os\nos.environ['COLAB_AUTOPILOT_MODEL']=${JSON.stringify(model)}\n`+python;}
export class Autopilot {
  constructor({mcp=callMcp,stateFile,model='qwen3:4b-instruct-2507-q4_K_M',logger=console,waitMs=240000,pollMs=5000}={}) {
    if(!stateFile)throw Error('stateFile required');Object.assign(this,{mcp,stateFile,model,logger,waitMs,pollMs});this.state=null;this.pending=null;this.busy=0;
  }
  async load(){try{const s=JSON.parse(await readFile(this.stateFile,'utf8'));if(s?.owned===true && /^runtimes\/r-[a-z0-9-]+$/.test(s.runtime))this.state=s;}catch(e){if(e.code!=='ENOENT')throw e;}}
  async save(value){await mkdir(dirname(this.stateFile),{recursive:true,mode:0o700});const tmp=this.stateFile+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,this.stateFile);this.state=value;}
  async clear(){await this.save({});}
  async getOwned(){
    if(!this.state?.owned)return null;
    const result=await this.mcp('list_runtimes',{});
    const runtime=(result.runtimes||[]).find(x=>x.name===this.state.runtime);
    if(!runtime){
      const stale=this.state.runtime;
      await this.clear();
      this.logger.log(`Cleared stale Autopilot state: runtime ${stale} no longer exists`);
      return null;
    }
    return runtime;
  }
  async ensure(){if(this.pending)return this.pending;this.pending=this.provision().finally(()=>{this.pending=null;});return this.pending;}
  async provision(){
    let runtime=await this.getOwned();
    if(!runtime){
      const specs=await this.mcp('list_runtime_specs',{});
      const eligible=(specs.runtimeSpecs||[]).some(s=>s.eligible===true && Object.keys(SPEC).every(k=>s.key?.[k]===SPEC[k]));
      if(!eligible)throw Error('T4 Standard is not eligible for this account');
      // A previous create can succeed even if its operation response was not parsed.
      // Refuse to create another GPU when an unmanaged T4 Standard already exists.
      const prior=await this.mcp('list_runtimes',{});
      const t4 = x => Object.keys(SPEC).every(k=>x.runtimeSpec?.[k]===SPEC[k]);
      const existing=(prior.runtimes||[]).filter(t4);
      if(existing.length)throw Error(`Unmanaged T4 Standard runtime(s) exist: ${existing.map(x=>x.name).join(', ')}. Check before creating another; Autopilot will not adopt or delete them.`);
      const op=await this.mcp('create_runtime',{runtime:{runtimeSpec:SPEC}});
      const candidates=[op.metadata?.runtime,op.runtime?.name,op.response?.name,op.response?.runtime?.name,op.name];
      let name=candidates.find(n=>typeof n==='string' && /^runtimes\/[a-z0-9][a-z0-9-]{0,62}$/.test(n));
      const started=Date.now();
      // Some Colab calls return only an operations/... name. Discover the
      // newly-created runtime rather than treating the operation as a runtime.
      if(!name){
        while(Date.now()-started<this.waitMs){
          const listed=await this.mcp('list_runtimes',{});
          const found=(listed.runtimes||[]).filter(t4);
          if(found.length===1){name=found[0].name;break;}
          if(found.length>1)throw Error('Multiple newly listed T4 runtimes; refusing to claim ownership. Inspect Colab runtimes.');
          await sleep(this.pollMs);
        }
      }
      if(!name)throw Error(`Create operation ${String(op.name||'unknown')} returned no runtime after polling. Inspect Colab runtimes before retrying.`);
      await this.save({owned:true,runtime:name,session:null,ready:false});
      const start=Date.now();
      while(Date.now()-start<this.waitMs){runtime=await this.getOwned();if(runtime)break;await sleep(this.pollMs);}
      if(!runtime)throw Error('Runtime not visible before timeout');
    }
    const name=this.state.runtime;
    let session=this.state.session;
    if(!session){const created=await this.mcp('create_session',{parent:name,sessionId:'openclaw-autopilot'});session=created.name;if(!session)throw Error('No session returned');await this.save({...this.state,session,ready:false});}
    if(!this.state.ready){
      const result=asError(await this.mcp('execute_code',{session,code:bootstrapCode(this.model)},{timeoutMs:600000}));
      if(!result.ready)throw Error(`Bootstrap failed: ${result.error}`);
      await this.save({...this.state,ready:true});
    }
    return session;
  }
  async release(){
    if(this.pending||this.busy>0)return false;
    if(!this.state?.owned)return false;
    const name=this.state.runtime;
    // Deleting a missing runtime is already complete; do not retry forever.
    const listed=await this.mcp('list_runtimes',{});
    if(!(listed.runtimes||[]).some(r=>r.name===name)){
      await this.clear();
      this.logger.log(`Cleared stale Autopilot state: runtime ${name} already absent`);
      return true;
    }
    try {
      await this.mcp('delete_runtime',{name});
    } catch(e) {
      // A 404 can race with the list; re-check before treating it as failure.
      if(!/not found|NOT_FOUND|404|Requested entity was not found/i.test(String(e.message)))throw e;
      const again=await this.mcp('list_runtimes',{});
      if((again.runtimes||[]).some(r=>r.name===name))throw e;
      await this.clear();
      this.logger.log(`Cleared stale Autopilot state: runtime ${name} no longer exists`);
      return true;
    }
    await this.clear();this.logger.log(`Released owned Colab runtime ${name}`);return true;
  }
}
export {bootstrapCode,asError};
