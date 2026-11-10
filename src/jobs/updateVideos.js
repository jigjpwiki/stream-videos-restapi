import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getChannelVideos } from '../services/youtube.js';
import { guardedEdit } from '../services/wikiwiki.js';
import { insertVideoIntoPage, isVideoAlreadyInPage } from '../formatter/wikiTextFormatter.js';

export async function updateLiverVideos(liver, apiKey, {
  wiki, cache, now = new Date(), daysBack = 14, lastSuccessAt,
  dryRun = true, writeEnabled = false, output = 'work/videos', fetchVideos = getChannelVideos,
} = {}) {
  const channel = liver.youtubeChannelId;
  const videos = await fetchVideos(channel, apiKey, { daysBack, now, lastSuccessAt });
  // Details remain useful for PR2/history even when already present in the Wiki.
  const metadata = Object.fromEntries((cache[channel] ?? []).map(v => [v.videoId, v]));
  for (const video of videos) metadata[video.videoId] = { ...metadata[video.videoId], ...video, fetchedAt: now.toISOString() };
  let added = 0;
  await mkdir(output, { recursive: true });
  const result = await guardedEdit({ wiki, page: liver.wikiPageName, dryRun, writeEnabled,
    transform(source) {
      let next = source;
      for (const video of [...videos].sort((a,b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))) {
        // Wiki is authoritative: a cache hit must never suppress a required edit.
        // Existing IDs in any section respect human classification indefinitely.
        if (isVideoAlreadyInPage(next, video.videoId)) continue;
        const inserted = insertVideoIntoPage(next, video);
        if (inserted === null) throw new Error('Required video section missing');
        next = inserted; added++;
      }
      return next;
    },
    async save(before, after) {
      await writeFile(join(output, `${channel}.before.wiki`), before);
      await writeFile(join(output, `${channel}.preview.wiki`), after);
    },
  });
  if (!dryRun && writeEnabled) cache[channel] = Object.values(metadata);
  return { success: true, fetched: videos.length, newVideosCount: added, ...result };
}
