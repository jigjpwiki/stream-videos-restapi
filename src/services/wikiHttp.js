import {httpClient, HttpRequestError} from '../schedule/http.js';
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
// Local conservative pacing policy, NOT a claim about WIKIWIKI's unpublished quota.
// Shared across schedule, classification and video clients in this process.
export function createWikiRateLimit({sleep=sleepDefault,clock=()=>Date.now(),intervalMs=1000}={}) {
  let tail=Promise.resolve(),next=0,consecutive=0,paused=false,retryAt=0;
  function deferred(operation) { const error=new HttpRequestError('Wiki API','rate_limited',429,Math.max(0,retryAt-clock()));error.operation=operation;return error; }
  return {
    restore(value) {const time=Date.parse(value);if(time>clock()){retryAt=Math.max(retryAt,time);paused=true;}},
    snapshot() {return paused?{retryAt:new Date(retryAt).toISOString()}:{};},
    async run(request,operation,method) {
      const task=tail.then(async()=>{
        if(paused)throw deferred(operation);
        for(let attempt=0;attempt<3;attempt++) {
          await sleep(Math.max(0,next-clock()));next=clock()+intervalMs;
          try {const value=await request();consecutive=0;return value;}
          catch(error) {
            if(!(error instanceof HttpRequestError))throw error;
            error.operation=operation;
            const limited=error.status===429;
            if(limited) {
              consecutive++;
              const wait=Math.max(intervalMs,error.retryAfterMs??1000*2**attempt);
              // Do not hold a whole Actions job for a long server cooldown.
              if(consecutive>=2||wait>5000) {paused=true;retryAt=Math.max(retryAt,clock()+Math.max(wait,consecutive>=2?30000:0));}
              console.warn(JSON.stringify({phase:'wiki_api',operation,status:429,attempt:attempt+1,deferred:paused,retryAfterMs:error.retryAfterMs}));
              if(paused)throw deferred(operation);
              next=Math.max(next,clock()+wait);
            }else consecutive=0;
            // No PUT replay, even for 429 or a lost response. Read/verify instead.
            if(method==='PUT'||attempt===2)throw error;
            if(!limited)next=Math.max(next,clock()+1000*2**attempt);
          }
        }
      });
      tail=task.catch(()=>{});return task;
    },
  };
}
export const wikiRateLimit=createWikiRateLimit();
export function wikiHttpClient(fetchImpl=fetch,{rateLimit=wikiRateLimit,sleep=sleepDefault}={}) {
  const once=httpClient(fetchImpl,sleep,{maxAttempts:1});
  return (label,url,options={})=>{
    const {wikiOperation,...httpOptions}=options;
    const fallback=label==='Wiki auth'?'auth':options.method==='PUT'?'put':'get';
    const operation=['auth','get','conflict_get','put','verify_get'].includes(wikiOperation)?wikiOperation:fallback;
    return rateLimit.run(()=>once(label,url,httpOptions),operation,options.method??'GET');
  };
}
