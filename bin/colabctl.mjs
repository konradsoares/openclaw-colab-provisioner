#!/usr/bin/env node
import fs from 'node:fs';
import {listSpecs,listRuntimes,getSubscription,getRuntime,createRuntime,deleteRuntime,maskSecrets,validateSpec} from '../lib/colab-api.mjs';
const usage=`colabctl (read-only by default)
  help                    Show this help
  specs                   List available GPU/CPU specifications and eligibility
  list                    List assigned runtimes (redacts connection credentials)
  subscription            Show subscription metadata (redacted)
  get runtimes/ID         Retrieve runtime metadata (redacted)
  create --spec N --confirm-create     Provision by zero-based index from eligible specs
  delete runtimes/ID --confirm-delete  Delete runtime assignment (may lose session data)

Auth: export COLAB_ACCESS_TOKEN from a legitimate OAuth consent flow (Colab scope).
The CLI never acquires credentials or provisions GPUs in the background.
No usage/billing guarantee; check your Google account before create.
`;
async function main(args){
 const [command,...rest]=args;
 if(!command || command==='help'||command==='--help')return console.log(usage);
 const out=x=>console.log(JSON.stringify(maskSecrets(x),null,2));
 if(command==='specs')return out(await listSpecs());
 if(command==='list')return out(await listRuntimes());
 if(command==='subscription')return out(await getSubscription());
 if(command==='get'){if(rest.length!==1)throw Error('Usage: get runtimes/ID');return out(await getRuntime(rest[0]));}
 if(command==='create'){
   if(!rest.includes('--confirm-create'))throw Error('Create blocked: requires --confirm-create');
   const idx=rest.indexOf('--spec');if(idx<0||!/^\d+$/.test(rest[idx+1]||''))throw Error('Specify --spec N from colabctl specs');
   const specs=(await listSpecs()).runtimeSpecs??[];
   const chosen=specs[Number(rest[idx+1])];if(!chosen)throw Error('Specification index not found');
   const spec=validateSpec(chosen.key,specs);
   console.error(`Creating eligible runtime spec: ${JSON.stringify(spec)}. GPU allocation may consume compute units.`);
   return out(await createRuntime(spec));
 }
 if(command==='delete'){
   if(rest.length!==2||rest[1]!=='--confirm-delete')throw Error('Usage: delete runtimes/ID --confirm-delete');
   console.error(`Deleting runtime assignment ${rest[0]}`);
   return out(await deleteRuntime(rest[0]));
 }
 throw Error('Unknown command. Run colabctl help');
}
main(process.argv.slice(2)).catch(e=>{console.error('colabctl:',e.message);process.exitCode=1;});
