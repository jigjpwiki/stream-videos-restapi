import {readFile} from 'node:fs/promises';
import {wikiRateLimit} from './services/wikiHttp.js';
import { run as schedule } from './schedule/index.js';
import { runClassifications } from './classification/sync.js';
import { runVideos } from './jobs/videoBatch.js';

// Each phase is isolated; classification will use this same writer and state in PR2.
export async function runSync({ env = process.env, runSchedule = schedule, runVideoBatch = runVideos,
  applyClassifications = runClassifications,
} = {}) {
  // Restore the server cooldown before the schedule's first Wiki request, too.
  try {const state=JSON.parse(await readFile('data/classification-state.json','utf8'));wikiRateLimit.restore(state.wikiRetryAt);}catch(error){if(error.code!=='ENOENT')throw error;}
  const results = {};
  for (const [name, operation] of [['schedule', () => runSchedule({ env })],
    ['classifications', () => applyClassifications({ env })],
    ['videos', () => env.UNIFIED_VIDEOS_ENABLED === 'true' ? runVideoBatch({ env }) : { skipped: true }]]) {
    try {
      results[name] = await operation();
      if (name === 'videos' && Object.values(results[name]?.results ?? {}).some(r=>!r.success)) results[name].failed = true;
    } catch { results[name] = { failed: true }; }
  }
  return results;
}
