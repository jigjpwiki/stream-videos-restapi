import { run as schedule } from './schedule/index.js';
import { runVideos } from './jobs/videoBatch.js';

// Each phase is isolated; classification will use this same writer and state in PR2.
export async function runSync({ env = process.env, runSchedule = schedule, runVideoBatch = runVideos,
  applyClassifications = async () => ({ skipped: true }),
} = {}) {
  const results = {};
  for (const [name, operation] of [['schedule', () => runSchedule({ env })],
    ['classifications', () => applyClassifications({ env })],
    ['videos', () => env.UNIFIED_VIDEOS_ENABLED === 'true' ? runVideoBatch({ env }) : { skipped: true }]]) {
    try {
      results[name] = await operation();
      if (Object.values(results[name]?.results ?? {}).some(r=>!r.success)) results[name].failed = true;
    } catch { results[name] = { failed: true }; }
  }
  return results;
}
