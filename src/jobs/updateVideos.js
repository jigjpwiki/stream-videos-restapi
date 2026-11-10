import { savePreview } from '../services/preview.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getChannelVideos } from '../services/youtube.js';
import { guardedEdit } from '../services/wikiwiki.js';
import { insertVideoIntoPage, isVideoAlreadyInPage, formatVideoLine } from '../formatter/wikiTextFormatter.js';

export async function updateLiverVideos(liver, apiKey, {
  wiki, cache, now = new Date(), daysBack = 14, lastSuccessAt,
  dryRun = true, writeEnabled = false, output = 'work/videos', fetchVideos = getChannelVideos, classifier, custodyEnabled = !!classifier, ingestionLimit = 10, checkpointCache = async()=>{},
} = {}) {
  const channel = liver.youtubeChannelId;
  let videos = await fetchVideos(channel, apiKey, { daysBack, now, lastSuccessAt });
  // Details remain useful for PR2/history even when already present in the Wiki.
  const metadata = Object.fromEntries((cache[channel] ?? []).map(v => [v.videoId, v]));
  for (const video of videos) metadata[video.videoId] = { ...metadata[video.videoId], ...video, fetchedAt: now.toISOString() };
  if(classifier){
    // Durable outbox precedes every remote mutation; failures keep full fetched records.
    for(const video of videos)metadata[video.videoId].pendingIngestion=true;
    videos=[...new Map([...Object.values(metadata).filter(v=>v.pendingIngestion),...videos].map(v=>[v.videoId,v])).values()];
    if(!dryRun&&writeEnabled){cache[channel]=Object.values(metadata);await checkpointCache(cache);}
  }
  const managed=new Map();
  if(classifier)for(let i=0;i<videos.length;i+=100){const keys=videos.slice(i,i+100).map(v=>encodeURIComponent(liver.wikiPageName)+':'+v.videoId);const data=await classifier('/internal/lookup',{keys});if(!Array.isArray(data.items))throw Error('Invalid classifier lookup');for(const item of data.items)managed.set(item.videoId,item);}
  if(classifier){const state=await classifier('/internal/custody-status?page='+encodeURIComponent(liver.wikiPageName));if(state.pending>0)throw Error('Wiki page has a pending custody transfer');}
  const queuePreview=[];
  let added = 0;
  await mkdir(output, { recursive: true });
  const result = await guardedEdit({ wiki, page: liver.wikiPageName, dryRun, writeEnabled,
    async transform(source) {
      let next = source;
      for (const video of [...videos].sort((a,b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))) {
        // Cloudflare decisions suppress automatic rediscovery. Unmanaged Wiki rows
        // remain authoritative, including human classifications in any section.
        const existing=managed.get(video.videoId);
        if(metadata[video.videoId]?._cloudflareManaged)continue;
        if(existing&&(existing.authority==='cloudflare'||existing.choice!==null||existing.receipt||existing.outcome==='external')){metadata[video.videoId]._cloudflareManaged=true;continue;}
        if (isVideoAlreadyInPage(next, video.videoId)) continue;
        if(classifier&&custodyEnabled&&video.videoType==='uncategorized'){
          const row={videoId:video.videoId,line:formatVideoLine(video),metadata:video};queuePreview.push(row);
          if(!dryRun&&writeEnabled){
            if(queuePreview.length>ingestionLimit)throw Error('Direct queue batch limit; retry durable outbox');
            const payload={operation:'register',page:liver.wikiPageName,name:liver.name,row};
            const saved=await classifier('/internal/custody',payload);
            const verified=(await classifier('/internal/lookup',{keys:[encodeURIComponent(liver.wikiPageName)+':'+video.videoId]})).items?.[0];
            if(saved.item?.authority!=='cloudflare'||verified?.authority!=='cloudflare'||verified.videoId!==video.videoId||verified.custody?.phase!=='committed'||typeof verified.line!=='string')throw Error('Queue registration not verified');
            metadata[video.videoId]._cloudflareManaged=true;
          }
          continue;
        }
        const inserted = insertVideoIntoPage(next, video);
        if (inserted === null) throw new Error('Required video section missing');
        next = inserted; added++;
      }
      return next;
    },
    async save(before, after) {
      await savePreview(join(output, channel), before, after);
    },
  });
  await writeFile(join(output,`${channel}.queue-preview.json`),JSON.stringify(queuePreview,null,2)+'\n');
  if (!dryRun && writeEnabled) {for(const entry of Object.values(metadata))entry.pendingIngestion=false;cache[channel] = Object.values(metadata);}
  return { success: true, fetched: videos.length, newVideosCount: added, ...result };
}
