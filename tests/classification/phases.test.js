import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runSync} from '../../src/sync.js';
import {run as runSchedule} from '../../src/schedule/index.js';
import {runClassifications} from '../../src/classification/sync.js';
import {runVideos} from '../../src/jobs/videoBatch.js';
import {createWikiRateLimit} from '../../src/services/wikiHttp.js';
import {videoWikiClient} from '../../src/services/wikiwiki.js';
import {HttpRequestError} from '../../src/schedule/http.js';
const env={WIKI_API_BASE_URL:'https://api.wikiwiki.jp/jigjp',WIKI_PASSWORD:'SECRET',YOUTUBE_API_KEY:'test',UNIFIED_VIDEOS_ENABLED:'true',CLASSIFIER_SYNC_ENABLED:'true',DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true',WIKI_WRITE_ENABLED:'true'};
const livers=Array.from({length:3},(_,i)=>({name:'L'+i,wikiPageName:'L'+i+'/動画一覧',youtubeChannelId:'UC'+i,enabled:true}));
const videoState={channels:{UC0:{lastSuccessAt:'2026-11-09T00:00:00Z',lastAttemptAt:'2026-11-09T00:00:00Z',failures:2,status:'failed'}}};
const row='-06/01 &color(red){■};[[title:https://youtu.be/abcdefghijk]]';
const source='**投稿動画 [#edited_videos]\n***Shorts動画 [#shorts]\n***Shorts・投稿動画未分類（自動取得） [#uncategorized]\n#fold(未分類動画一覧,close){{\n'+row+'\n}}\n';
const candidate={page:livers[0].wikiPageName,key:encodeURIComponent(livers[0].wikiPageName)+':abcdefghijk',videoId:'abcdefghijk',revision:3,choice:'shorts',line:row,metadata:{videoId:'abcdefghijk',title:'title',publishedAt:'2023-06-01T00:00:00Z',durationSeconds:30}};
async function fixture(fn){const output=await mkdtemp(join(tmpdir(),'wiki-phases-'));try{let time=Date.now();const rateLimit=createWikiRateLimit({clock:()=>time,sleep:async ms=>{time+=ms;}});await fn({output,rateLimit});}finally{await rm(output,{recursive:true,force:true});}}
test('schedule Wiki 429 is deferred in its artifact and shared with classification/video; no later Wiki or YouTube update, state intact',()=>fixture(async({output,rateLimit})=>{
 const requests=[],remoteWrites=[],videoSaves=[];let updates=0,cooldownState={scanIndex:7,keep:'preserved'};
 const fetcher=async(url)=>{requests.push(url);if(url.includes('jigdule'))return Response.json([]);if(url.endsWith('/auth'))return Response.json({token:'SECRET'});return new Response('SECRET',{status:429,headers:{'Retry-After':'120'}});};
 const report=await runSync({env,rateLimit,loadCooldown:async()=>structuredClone(cooldownState),persistCooldown:async s=>{cooldownState=s;},
  runSchedule:options=>runSchedule({...options,fetchImpl:fetcher,output:join(output,'schedule')}),
  applyClassifications:options=>runClassifications({...options,livers,state:{scanIndex:7},cache:{},output:join(output,'classes'),wiki:videoWikiClient(env,fetcher,{rateLimit}),remote:async(path,data)=>{if(data)remoteWrites.push(path);return path==='/internal/pending'?{items:[candidate]}:{};},persist:async()=>{}}),
  runVideoBatch:options=>runVideos({...options,livers,state:videoState,cache:{},output:join(output,'videos'),wiki:videoWikiClient(env,fetcher,{rateLimit}),update:async()=>{updates++;assert.fail('Must defer before fetching videos');},persistState:async s=>videoSaves.push(s),persistCache:async()=>assert.fail('No cache mutation')})});
 assert.equal(report.schedule.outcome,'deferred');assert.equal(report.schedule.status,429);assert.equal(report.schedule.failed,false);
 assert.equal(JSON.parse(await readFile(join(output,'schedule/report.json'))).outcome,'deferred');
 assert.equal(report.classifications.outcome,'deferred');assert.equal(report.classifications.results[0].outcome,'deferred');assert.equal(report.videos.outcome,'deferred');assert.equal(report.videos.failed,false);assert.equal(report.videos.deferred,3);assert.equal(report.summary.outcome,'deferred');assert.equal(report.summary.complete,false);
 assert.equal(requests.filter(u=>u.startsWith('https://api.wikiwiki')).length,2);assert.equal(updates,0);assert.equal(videoSaves.length,0);assert.deepEqual(report.videos.channels,videoState.channels);assert.deepEqual(remoteWrites,[]);assert.equal(cooldownState.keep,'preserved');assert.equal(cooldownState.scanIndex,7);assert.ok(cooldownState.wikiRetryAt);
}));
test('classification verification 429 defers later videos, retains prepare/revision and previously saved receipt without ack',()=>fixture(async({output,rateLimit})=>{
 let text=source,puts=0,prepared;const remoteWrites=[];let stored={scanIndex:0,keep:'preserved'};
 const fetcher=async(url,options)=>{if(url.endsWith('/auth'))return Response.json({token:'SECRET'});if(options.method==='PUT'){puts++;text=JSON.parse(options.body).source;return new Response('',{status:200});}if(puts)return new Response('',{status:429,headers:{'Retry-After':'60'}});return Response.json({source:text});};
 const report=await runSync({env,rateLimit,loadCooldown:async()=>structuredClone(stored),persistCooldown:async s=>{stored=s;},runSchedule:async()=>({written:false}),
  applyClassifications:options=>runClassifications({...options,livers:livers.slice(0,1),state:stored,cache:{},wiki:videoWikiClient(env,fetcher,{rateLimit}),output:join(output,'classes'),remote:async(path,data)=>{if(data)remoteWrites.push(path);if(path==='/internal/pending')return {items:[candidate]};if(path==='/internal/prepare')prepared=data;return {};},persist:async s=>{stored={...stored,...s};}}),
  runVideoBatch:options=>runVideos({...options,livers,state:videoState,cache:{},wiki:videoWikiClient(env,fetcher,{rateLimit}),output:join(output,'videos'),update:async()=>assert.fail('No update during cooldown'),persistState:async()=>assert.fail(),persistCache:async()=>assert.fail()})});
 assert.equal(puts,1);assert.equal(prepared.revision,3);assert.ok(prepared.receipt);assert.ok(!remoteWrites.includes('/internal/ack'));assert.equal(report.classifications.results[0].operation,'verify_get');assert.equal(report.classifications.writeUnverified,true);assert.equal(report.videos.outcome,'deferred');assert.deepEqual(report.videos.channels,videoState.channels);assert.equal(report.summary.outcome,'deferred');assert.equal(stored.keep,'preserved');assert.ok(stored.wikiRetryAt);assert.equal(candidate.revision,3);
}));
test('schedule authentication/5xx failures remain genuine and a later phase error is never hidden by cooldown',()=>fixture(async({output,rateLimit})=>{
 for(const status of [401,403,503]){
  const result=await runSync({env:{...env,UNIFIED_VIDEOS_ENABLED:'false'},rateLimit,loadCooldown:async()=>({}),persistCooldown:async()=>assert.fail(),
   runSchedule:options=>runSchedule({...options,output:join(output,'S'+status),fetchImpl:async url=>url.includes('jigdule')?Response.json([]):new Response('SECRET',{status})}),applyClassifications:async()=>({failed:false})});
  assert.equal(result.schedule.failed,true);assert.equal(result.schedule.status,status);assert.equal(result.summary.outcome,'failure');assert.equal(result.summary.deferred,false);
 }
 const error=new HttpRequestError('Wiki GET','http_error',429,60000);error.operation='get';
 const mixed=await runSync({env,rateLimit,loadCooldown:async()=>({}),persistCooldown:async()=>{},runSchedule:async()=>{throw error;},applyClassifications:async()=>{throw new HttpRequestError('Classifier','http_error',403);},runVideoBatch:async()=>({results:{UC0:{success:false,outcome:'deferred'}},outcome:'deferred',deferred:1})});
 assert.equal(mixed.schedule.outcome,'deferred');assert.equal(mixed.classifications.failed,true);assert.equal(mixed.classifications.status,403);assert.equal(mixed.videos.failed,undefined);assert.equal(mixed.summary.outcome,'failure');assert.equal(mixed.summary.deferred,true);
}));
test('video-origin 429 rolls back attempt/failure counters, skips remaining targets and checkpoints shared cooldown; dry-run never persists it',()=>fixture(async({output,rateLimit})=>{
 let updates=0,saved,cooldown={scanIndex:11};const error=new HttpRequestError('Wiki GET','http_error',429,60000);error.operation='get';
 const result=await runSync({env,rateLimit,loadCooldown:async()=>structuredClone(cooldown),persistCooldown:async s=>{cooldown=s;},runSchedule:async()=>({}),applyClassifications:async()=>({skipped:true}),runVideoBatch:options=>runVideos({...options,livers,state:videoState,cache:{},wiki:{},output,update:async()=>{updates++;throw error;},persistState:async s=>{saved=s;},persistCache:async()=>{}})});
 assert.equal(updates,1);assert.equal(result.videos.deferred,3);assert.deepEqual(saved.channels,videoState.channels);assert.equal(result.summary.failed,false);assert.ok(cooldown.wikiRetryAt);assert.equal(cooldown.scanIndex,11);
 await runSync({env:{...env,DRY_RUN:'true'},rateLimit,loadCooldown:async()=>cooldown,persistCooldown:async()=>assert.fail('Dry Run mutation'),runSchedule:async()=>({outcome:'deferred',deferred:true}),applyClassifications:async()=>({skipped:true}),runVideoBatch:async()=>({outcome:'deferred',deferred:3})});
}));
test('a genuine video error before cooldown is retained alongside deferred channels; checkpoint failures also remain errors',()=>fixture(async({output,rateLimit})=>{
 let calls=0;const error=new HttpRequestError('Wiki GET','http_error',429,60000);error.operation='get';
 const result=await runSync({env,rateLimit,loadCooldown:async()=>({}),persistCooldown:async()=>{throw Error('SECRET');},runSchedule:async()=>({}),applyClassifications:async()=>({skipped:true}),runVideoBatch:options=>runVideos({...options,livers,state:{channels:{}},cache:{},wiki:{},output,update:async()=>{calls++;if(calls===1)throw new HttpRequestError('Wiki GET','http_error',403);throw error;},persistState:async()=>{},persistCache:async()=>{}})});
 assert.equal(calls,2);assert.equal(Object.values(result.videos.results).filter(r=>r.outcome==='failed').length,1);assert.equal(result.videos.deferred,2);assert.equal(result.videos.failed,true);assert.equal(result.videos.outcome,'failure');assert.equal(result.cooldownCheckpoint.failed,true);assert.equal(result.summary.outcome,'failure');assert.equal(result.summary.deferred,true);assert.ok(!JSON.stringify(result).includes('SECRET'));
}));
