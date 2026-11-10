import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVideos, selectDue, positiveInt } from '../../src/jobs/videoBatch.js';
import { updateLiverVideos } from '../../src/jobs/updateVideos.js';
import { getChannelVideos, fetchVideoIds, quotaRequest } from '../../src/services/youtube.js';
import { guardedEdit, videoWikiClient } from '../../src/services/wikiwiki.js';
import { runSync } from '../../src/sync.js';
const now = new Date('2026-11-10T03:00:00Z');
const livers = [0,1,2,3].map(n => ({ name: `L${n}`, youtubeChannelId: `UC${n}`, wikiPageName: `L${n}/動画一覧`, enabled: n !== 3 }));
const source = '**ライブ配信（アーカイブ） [#archives]\n**投稿動画 [#edited_videos]\n***Shorts動画 [#shorts]\n';
const video = { videoId:'abcdefghijk',title:'Original title',url:'https://www.youtube.com/watch?v=abcdefghijk',publishedAt:'2026-10-31T16:00:00Z',videoType:'normal',durationSeconds:200 };
async function temporary(fn) { const output = await mkdtemp(join(tmpdir(),'video-test-'));try {return await fn(output);} finally {await rm(output,{recursive:true,force:true});} }
test('inventory: 73 configured / 52 enabled / 21 disabled; defaults are validated',async()=>{
 const config=JSON.parse(await readFile(new URL('../../src/config/livers.json',import.meta.url)));
 assert.equal(config.length,73);assert.equal(config.filter(l=>l.enabled).length,52);
 assert.equal(new Set(config.map(l=>l.youtubeChannelId)).size,73);
 for(const v of ['x','0','-1','53','1.2'])assert.throws(()=>positiveInt(v,5,52));
});
test('due selection migrates legacy index; skips fresh and disabled; failures retry without starving others',()=>{
 assert.equal(selectDue(livers,{lastIndex:42},now,{batchSize:2}).length,2);
 const state={channels:{UC0:{lastSuccessAt:now.toISOString()},UC1:{lastAttemptAt:now.toISOString(),status:'failed'}}};
 assert.deepEqual(selectDue(livers,state,now).map(l=>l.youtubeChannelId),['UC2','UC1']);
 assert.equal(selectDue(livers,{channels:{UC0:{lastSuccessAt:'2026-11-10T01:00:00Z'}}},now).length,3);
});
test('Dry Run and write-disabled runs never persist state/cache or write Wiki even if caller requests live',()=>temporary(async output=>{
 for(const env of [{DRY_RUN:'true',VIDEO_WIKI_WRITE_ENABLED:'true'},{DRY_RUN:'false'}]){
 const original={lastIndex:1}; const cache={};let saves=0,puts=0;
 const report=await runVideos({env:{YOUTUBE_API_KEY:'test',...env},livers,state:original,cache,now,output,wiki:{get:async()=>source,put:async()=>puts++},
 update:(l,k,o)=>updateLiverVideos(l,k,{...o,fetchVideos:async()=>[video]}),persistState:async()=>saves++,persistCache:async()=>saves++});
 assert.equal(report.dryRun,true);assert.equal(puts,0);assert.equal(saves,0);assert.deepEqual(original,{lastIndex:1});assert.deepEqual(cache,{});
 assert.match(await readFile(join(output,'UC0.preview.wiki'),'utf8'),/Original title/);
 }
}));
test('partial failures continue, checkpoint successes only, failed watermark unchanged and fair retry',()=>temporary(async output=>{
 const saved=[];const previous='2026-11-01T00:00:00Z';
 const report=await runVideos({env:{YOUTUBE_API_KEY:'test',DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true'},livers,state:{channels:{UC0:{lastSuccessAt:previous}}},cache:{},now,output,wiki:{},
 update:async l=>{if(l.youtubeChannelId==='UC0')throw new Error('SECRET');return {success:true};},persistState:async s=>saved.push(structuredClone(s)),persistCache:async()=>{}});
 assert.equal(report.results.UC0.success,false);assert.equal(report.results.UC2.success,true);assert.equal(saved.length,3);
 assert.equal(report.channels.UC0.lastSuccessAt,previous);assert.equal(report.channels.UC0.failures,1);
 assert.equal(report.channels.UC1.lastSuccessAt,now.toISOString());
 assert.deepEqual(selectDue(livers,saved.at(-1),new Date(+now+600000)).map(l=>l.youtubeChannelId),['UC0']);
 assert.ok(!(await readFile(join(output,'report.json'),'utf8')).includes('SECRET'));
}));
test('fresh Wiki overrides stale cache; ambiguous PUT followed by rerun never duplicates or overwrites manual category',()=>temporary(async output=>{
 let text=source,puts=0;const cache={UC0:[{...video,videoType:'shorts'}]};
 const wiki={get:async()=>text,put:async(p,s)=>{puts++;text=s;throw new Error('lost response');}};
 const opts={wiki,cache,now,output,dryRun:false,writeEnabled:true,fetchVideos:async()=>[video]};
 await assert.rejects(updateLiverVideos(livers[0],'test',opts));
 const result=await updateLiverVideos(livers[0],'test',opts);
 assert.equal(puts,1);assert.equal(result.newVideosCount,0);assert.equal(text.split(video.videoId).length-1,1);
 const manuallyClassified=text;await updateLiverVideos(livers[0],'test',{...opts,fetchVideos:async()=>[{...video,videoType:'shorts'}]});assert.equal(text,manuallyClassified);
}));
test('conflict, backup failure, missing section and verification failure abort safely',()=>temporary(async output=>{
 let puts=0,gets=0;
 await assert.rejects(guardedEdit({wiki:{get:async()=>gets++?'human edit':source,put:async()=>puts++},page:'x',transform:s=>s+'auto',save:async()=>{},dryRun:false,writeEnabled:true}));assert.equal(puts,0);
 await assert.rejects(guardedEdit({wiki:{get:async()=>source,put:async()=>puts++},transform:s=>s+'auto',save:async()=>{throw Error();},dryRun:false,writeEnabled:true}));assert.equal(puts,0);
 await assert.rejects(updateLiverVideos(livers[0],'test',{wiki:{get:async()=>'',put:async()=>puts++},cache:{},output,fetchVideos:async()=>[video]}));
 await assert.rejects(guardedEdit({wiki:{get:async()=>source,put:async()=>puts++},transform:s=>s+'auto',save:async()=>{},dryRun:false,writeEnabled:true}));assert.equal(puts,1);
}));
test('Wiki client independently refuses writes without both explicit flags',async()=>{
 let calls=0;const client=videoWikiClient({WIKI_API_BASE_URL:'https://api.wikiwiki.jp/jigjp',WIKI_PASSWORD:'SECRET'},async()=>{calls++;return new Response('{}');});
 await assert.rejects(client.put('x','source'));assert.equal(calls,0);
});
test('uploads pagination, cutoff overlap, 50-item detail batches, original classification rules and missing date failure',async()=>{
 let detailCalls=0,playlistCalls=0;
 const ids=Array.from({length:51},(_,i)=>String(i).padStart(11,'a'));
 const request=async(label,url)=>{
 assert.ok(!url.includes('/search?'));
 if(label==='YouTube channels')return {items:[{id:'UC0',contentDetails:{relatedPlaylists:{uploads:'UU0'}}}]};
 if(label==='YouTube playlist')return playlistCalls++===0?{items:ids.map(videoId=>({contentDetails:{videoId,videoPublishedAt:'2026-11-10T00:00:00Z'}})),nextPageToken:'p2'}:{items:[{contentDetails:{videoId:'old',videoPublishedAt:'2025-01-01T00:00:00Z'}}],nextPageToken:'p3'};
 detailCalls++;return {items:new URL(url).searchParams.get('id').split(',').map((id,i)=>({id,snippet:{title:i===0?'#shorts title':'title',publishedAt:video.publishedAt},contentDetails:{duration:i===0?'PT5M':i===1?'PT1M':'PT4M'}}))};
 };
 const videos=await getChannelVideos('UC0','test',{request,now,daysBack:14,lastSuccessAt:'2026-10-01T00:00:00Z'});
 assert.equal(videos.length,51);assert.equal(detailCalls,2);assert.equal(playlistCalls,2);
 assert.equal(videos[0].videoType,'shorts');assert.equal(videos[1].videoType,'uncategorized');assert.equal(videos[2].videoType,'normal');
 await assert.rejects(fetchVideoIds('UC0','test','2026-01-01',{request:async()=>({items:[]})}));
});
test('quota caps physical attempts; schedule and classifications continue when video phase fails',async()=>{
 let physical=0;const {request,usage}=quotaRequest(1,async()=>{physical++;return new Response('{}');});
 await request('test','https://www.googleapis.com/youtube/v3/videos');
 await assert.rejects(request('test','https://www.googleapis.com/youtube/v3/videos'));assert.equal(physical,1);assert.equal(usage.used,1);
 const calls=[];const report=await runSync({env:{UNIFIED_VIDEOS_ENABLED:'true'},runSchedule:async()=>{calls.push('s');throw Error();},applyClassifications:async()=>calls.push('c'),runVideoBatch:async()=>calls.push('v')});
 assert.deepEqual(calls,['s','c','v']);assert.equal(report.schedule.failed,true);
});
