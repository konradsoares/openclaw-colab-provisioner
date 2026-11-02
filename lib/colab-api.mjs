const BASE='https://colaboratory.googleapis.com/v1beta';
export function assertRuntimeName(name) {
  if (!/^runtimes\/[a-z][a-z0-9-]{0,62}$/.test(String(name))) throw new Error('Invalid runtime name; expected runtimes/<id>');
  return name;
}
export async function callApi(path,{method='GET',body,token=process.env.COLAB_ACCESS_TOKEN,fetchImpl=fetch}={}){
  if (!token) throw new Error('COLAB_ACCESS_TOKEN is missing. Use a short-lived OAuth token with Colab scope.');
  if (!path.startsWith('/') || path.includes('..') || path.includes('//')) throw new Error('Invalid API path');
  const res=await fetchImpl(`${BASE}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`Colab API HTTP ${res.status}: ${JSON.stringify(data.error??data).slice(0,550)}`);
  return data;
}
export const listSpecs=(opts)=>callApi('/runtimespecs',opts);
export const listRuntimes=(opts)=>callApi('/runtimes',opts);
export const getSubscription=(opts)=>callApi('/subscription',opts);
export const getRuntime=(name,opts)=>callApi(`/${assertRuntimeName(name)}`,opts);
export const createRuntime=(spec,opts)=>callApi('/runtimes',{...opts,method:'POST',body:{runtimeSpec:spec}});
export const deleteRuntime=(name,opts)=>callApi(`/${assertRuntimeName(name)}`,{...opts,method:'DELETE'});
export function maskSecrets(obj) {
  if(Array.isArray(obj)) return obj.map(maskSecrets);
  if(obj && typeof obj==='object')return Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,/token|secret|credential|authorization|password/i.test(k)?'[REDACTED]':maskSecrets(v)]));
  return obj;
}
export function validateSpec(spec,eligibles){
  if(!spec || !['VARIANT_CPU','VARIANT_GPU','VARIANT_TPU'].includes(spec.variant) || typeof spec.accelerator!=='string'|| !['SHAPE_STANDARD','SHAPE_HIGHMEM'].includes(spec.shape)) throw new Error('Invalid runtime specification');
  if(!eligibles.some(s=>s.eligible && JSON.stringify(s.key)===JSON.stringify(spec))) throw new Error('Requested runtime specification is not among the eligible specs returned for this account');
  return spec;
}
