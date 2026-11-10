import {readFile,writeFile,rename} from 'node:fs/promises';
import {createWikiRateLimit,isWikiRateLimited} from './services/wikiHttp.js';
import {requestErrorDetails} from './schedule/http.js';
import { run as schedule } from './schedule/index.js';
import { runClassifications } from './classification/sync.js';
import { runVideos } from './jobs/videoBatch.js';
async function loadCooldownState(){try{return JSON.parse(await readFile('data/classification-state.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return {};}}
async function persistCooldownState(state){await writeFile('data/classification-state.json.tmp',JSON.stringify(state,null,2)+'\n');await rename('data/classification-state.json.tmp','data/classification-state.json');}

// Isolate true failures, but share one Wiki cooldown across every phase.
export async function runSync({ env = process.env, runSchedule = schedule, runVideoBatch = runVideos,
  applyClassifications = runClassifications,rateLimit=createWikiRateLimit(),
  loadCooldown=loadCooldownState,persistCooldown=persistCooldownState,
} = {}) {
  rateLimit.restore((await loadCooldown()).wikiRetryAt);
  const results = {};
  for (const [name, operation] of [['schedule', () => runSchedule({ env,rateLimit })],
    ['classifications', () => applyClassifications({ env,rateLimit })],
    ['videos', () => env.UNIFIED_VIDEOS_ENABLED === 'true' ? runVideoBatch({ env,rateLimit }) : { skipped: true }]]) {
    try {
      results[name] = await operation();
      if (name === 'videos' && Object.values(results[name]?.results ?? {}).some(r=>!r.success&&r.outcome!=='deferred')) results[name].failed = true;
    } catch(error) {
      if(isWikiRateLimited(error)){rateLimit.postpone(error);results[name]={failed:false,complete:false,deferred:true,outcome:'deferred',...requestErrorDetails(error),...rateLimit.snapshot()};}
      else results[name] = { failed: true,complete:false,outcome:'failure',...requestErrorDetails(error) };
    }
  }
  // Re-read after classification checkpointing: never overwrite its cursor or other state.
  // Also retain cooldowns originating in videos, or when classification is disabled/fails.
  const {retryAt}=rateLimit.snapshot();
  if(retryAt&&env.DRY_RUN==='false'&&env.VIDEO_WIKI_WRITE_ENABLED==='true'){
    try{const state=await loadCooldown();if(state.wikiRetryAt!==retryAt)await persistCooldown({...state,wikiRetryAt:retryAt});}
    catch{results.cooldownCheckpoint={failed:true,complete:false,outcome:'failure',reason:'cooldown_checkpoint_failed'};}
  }
  const phases=Object.values(results);
  const failed=phases.some(r=>r?.failed),deferred=phases.some(r=>r?.outcome==='deferred'||r?.deferred);
  results.summary={failed,deferred,complete:!failed&&!deferred,outcome:failed?'failure':deferred?'deferred':'success'};
  return results;
}
