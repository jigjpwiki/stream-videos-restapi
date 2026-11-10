import {classifierClient} from '../classification/sync.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadState, saveState, loadCache, saveCache } from '../services/storage.js';
import { videoWikiClient } from '../services/wikiwiki.js';
import { getChannelVideos, quotaRequest } from '../services/youtube.js';
import { updateLiverVideos } from './updateVideos.js';

export function positiveInt(value, fallback, max = 365) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value)) || +value < 1 || +value > max) throw new Error('Invalid positive integer configuration');
  return +value;
}
export function selectDue(livers, state, now, { batchSize = 5, intervalHours = 2 } = {}) {
  return livers.filter(l => l.enabled).filter(l => {
    const s = state.channels?.[l.youtubeChannelId];
    return !s?.lastSuccessAt || !Number.isFinite(Date.parse(s.lastSuccessAt)) || +now - Date.parse(s.lastSuccessAt) >= intervalHours * 3600000;
  }).sort((a,b) => {
    const sa = state.channels?.[a.youtubeChannelId] ?? {};
    const sb = state.channels?.[b.youtubeChannelId] ?? {};
    // Least recently attempted first avoids permanent failures starving unvisited channels.
    return (Date.parse(sa.lastAttemptAt) || 0) - (Date.parse(sb.lastAttemptAt) || 0) || a.youtubeChannelId.localeCompare(b.youtubeChannelId);
  }).slice(0, batchSize);
}
export async function runVideos({ env = process.env, now = new Date(), livers, state, cache, wiki,
  update = updateLiverVideos, persistState = saveState, persistCache = saveCache, output = 'work/videos',
} = {}) {
  const batchSize = positiveInt(env.BATCH_SIZE, 5, 52);
  const daysBack = positiveInt(env.DAYS_BACK, 14);
  const ingestionLimit = positiveInt(env.CLASSIFIER_INGEST_BATCH_SIZE, 10, 50);
  const intervalHours = positiveInt(env.VIDEO_INTERVAL_HOURS, 2, 168);
  const { request, usage } = quotaRequest(positiveInt(env.VIDEO_QUOTA_BUDGET, 40, 50));
  const dryRun = env.DRY_RUN !== 'false' || env.VIDEO_WIKI_WRITE_ENABLED !== 'true';
  livers ??= JSON.parse(await readFile(new URL('../config/livers.json', import.meta.url)));
  state = structuredClone(state ?? await loadState());
  cache = structuredClone(cache ?? await loadCache());
  state.version = 2; state.channels ??= {};
  const targets = selectDue(livers, state, now, { batchSize, intervalHours });
  const report = { processedAt: now.toISOString(), dryRun, total: livers.length, enabled: livers.filter(l=>l.enabled).length,
    selected: targets.map(l=>l.youtubeChannelId), results: {}, quota: usage, channels: state.channels };
  if (targets.length && !env.YOUTUBE_API_KEY) throw new Error('Missing YouTube API key');
  wiki ??= videoWikiClient(env);
  const classifier=(env.CLASSIFIER_CUSTODY_ENABLED==='true'||env.CLASSIFIER_CUSTODY_READ_ENABLED==='true')?classifierClient(env):undefined;
  for (const liver of targets) {
    const id = liver.youtubeChannelId;
    const status = state.channels[id] ??= {};
    status.firstAttemptAt ??= now.toISOString();
    const lastSuccessAt = status.lastSuccessAt ?? status.firstAttemptAt;
    status.lastAttemptAt = now.toISOString();
    try {
      const result = await update(liver, env.YOUTUBE_API_KEY, { wiki, cache, now, daysBack, lastSuccessAt, dryRun, writeEnabled: !dryRun, output, classifier, ingestionLimit, custodyEnabled:env.CLASSIFIER_CUSTODY_ENABLED==='true', checkpointCache:persistCache, fetchVideos: (channel, key, options) => getChannelVideos(channel, key, { ...options, request }) });
      if (!result.success) throw new Error('Liver update failed');
      status.lastSuccessAt = now.toISOString(); status.status = 'success'; status.failures = 0;
      report.results[id] = result;
    } catch {
      status.status = 'failed'; status.failures = (status.failures ?? 0) + 1;
      // Fixed diagnostic, no remote body or credentials. Failed attempts never move success watermark.
      report.results[id] = { success: false, error: 'Fetch, section, or Wiki conflict/write verification failed' };
    }
    // Checkpoint independently: one failed channel cannot discard another's progress.
    if (!dryRun) { await persistCache(cache); await persistState(state); }
  }
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ total: report.total, enabled: report.enabled, selected: targets.length, dryRun, failed: Object.values(report.results).filter(r=>!r.success).length }));
  return report;
}
