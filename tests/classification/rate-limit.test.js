import {wikiClient as scheduleWikiClient} from '../../src/schedule/sync.js';
import {runVideos} from '../../src/jobs/videoBatch.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HttpRequestError,retryAfterMs,requestErrorDetails} from '../../src/schedule/http.js';
import {createWikiRateLimit,wikiHttpClient} from '../../src/services/wikiHttp.js';
import {videoWikiClient,guardedEdit} from '../../src/services/wikiwiki.js';
import {runClassifications} from '../../src/classification/sync.js';
const env={CLASSIFIER_SYNC_ENABLED:'true',DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true',WIKI_API_BASE_URL:'https://api.wikiwiki.jp/jigjp',WIKI_PASSWORD:'SECRET'};
const row='-06/01 &color(red){■};[[title:https://www.youtube.com/watch?v=abcdefghijk]]';
const source='**投稿動画 [#edited_videos]\n***Shorts動画 [#shorts]\n***Shorts・投稿動画未分類（自動取得） [#uncategorized]\n#fold(未分類動画一覧,close){{\n'+row+'\n}}\n';
const item={page:'L/動画一覧',key:encodeURIComponent('L/動画一覧')+':abcdefghijk',videoId:'abcdefghijk',line:row,revision:1,choice:'shorts',metadata:{videoId:'abcdefghijk',title:'title',publishedAt:'2023-06-01T00:00:00Z',durationSeconds:30}};
const liver={name:'L',wikiPageName:item.page,youtubeChannelId:'UC0',enabled:false};
const rateError=(ms)=>new HttpRequestError('Wiki','http_error',429,ms);
function fakeGate(){let time=Date.now();const delays=[];return {delays,clock:()=>time,sleep:async ms=>{delays.push(ms);time+=ms;}};}
async function temporary(fn){const output=await mkdtemp(join(tmpdir(),'wiki-rate-'));try{await fn(output);}finally{await rm(output,{force:true,recursive:true});}}
test('Retry-After delta and HTTP date are safe; malformed, fractional and enormous values are not guessed',()=>{
 const now=Date.parse('2026-11-10T01:00:00Z');
 assert.equal(retryAfterMs('3',now),3000);assert.equal(retryAfterMs('Tue, 10 Nov 2026 01:00:07 GMT',now),7000);
 assert.equal(retryAfterMs('Tue, 10 Nov 2026 00:59:00 GMT',now),0);
 for(const value of [null,'','-3','0.5','999999999999999999999','SECRET'])assert.equal(retryAfterMs(value,now),undefined);
});
test('shared Wiki gate spaces every physical auth/GET/PUT attempt and serializes clients',async()=>{
 const fake=fakeGate(),rateLimit=createWikiRateLimit(fake),times=[];
 const fetcher=async()=>{times.push(fake.clock());return Response.json({source:'',token:'token'});};
 const a=wikiHttpClient(fetcher,{rateLimit}),b=wikiHttpClient(fetcher,{rateLimit});
 await Promise.all([a('Wiki auth','https://example.test',{method:'POST'}),b('Wiki GET','https://example.test'),a('Wiki PUT','https://example.test',{method:'PUT'})]);
 assert.deepEqual(times.map(t=>t-times[0]),[0,1000,2000]);
});
test('GET honors short Retry-After, recovers once, and never leaks response data',async()=>{
 const fake=fakeGate(),rateLimit=createWikiRateLimit(fake);let calls=0;const times=[];
 const request=wikiHttpClient(async()=>{times.push(fake.clock());return ++calls===1?new Response('SECRET',{status:429,headers:{'Retry-After':'3'}}):Response.json({ok:true});},{rateLimit});
 assert.deepEqual(await request('Wiki GET','https://example.test'),{ok:true});assert.equal(calls,2);assert.equal(times[1]-times[0],3000);
});
test('two consecutive 429s open circuit; long Retry-After immediately defers and all later calls avoid network',async()=>{
 for(const header of [undefined,'120']){
  const fake=fakeGate(),rateLimit=createWikiRateLimit(fake);let calls=0;
  const request=wikiHttpClient(async()=>{calls++;return new Response('SECRET',{status:429,headers:header?{'Retry-After':header}:{}});},{rateLimit});
  await assert.rejects(request('Wiki GET','https://example.test'),e=>{assert.equal(e.code,'rate_limited');assert.equal(e.operation,'get');assert.ok(e.retryAfterMs>=30000);return true;});
  await assert.rejects(request('Wiki PUT','https://example.test',{method:'PUT'}));assert.equal(calls,header?1:2);assert.ok(rateLimit.snapshot().retryAt);
 }
});
test('PUT 429 is never replayed; next GET respects server delay; ambiguous PUT is recovered only by exact read',async()=>{
 const fake=fakeGate(),rateLimit=createWikiRateLimit(fake);let calls=0;const times=[];
 const request=wikiHttpClient(async(url,options)=>{calls++;times.push(fake.clock());return options.method==='PUT'?new Response('',{status:429,headers:{'Retry-After':'4'}}):Response.json({ok:true});},{rateLimit});
 await assert.rejects(request('Wiki PUT','https://example.test',{method:'PUT'}));assert.equal(calls,1);
 await request('Wiki GET','https://example.test');assert.equal(times[1]-times[0],4000);
 let text='before',puts=0;const operations=[];
 const edit=await guardedEdit({wiki:{get:async(p,o)=>{operations.push(o.operation);return text;},put:async(p,s)=>{puts++;text=s;throw new HttpRequestError('Wiki PUT','network_error');}},page:'P',transform:()=> 'after',save:async()=>{},dryRun:false,writeEnabled:true});
 assert.equal(puts,1);assert.equal(edit.recovered,true);assert.deepEqual(operations,['get','conflict_get','verify_get']);
});
test('classification distinguishes successful, deferred, untouched results; resume never duplicates or acknowledges deferred revision',()=>temporary(async output=>{
 let text=source,state={},acks=[],puts=0,mode='limit',reads=0;let prepared;
 const other={...item,videoId:'lmnopqrstuv',key:encodeURIComponent(item.page)+':lmnopqrstuv'};
 const options={env,livers:[liver],cache:{},state,output,wiki:{get:async(p,o)=>{reads++;if(mode==='limit'&&o?.operation==='verify_get')throw rateError(120000);return text;},put:async(p,s)=>{puts++;text=s;}},
  remote:async(path,data)=>{if(path==='/internal/pending')return {items:[{...item,prepared},other]};if(path==='/internal/prepare')prepared={revision:data.revision,receipt:data.receipt};if(path==='/internal/ack')acks.push(...data.results);return {};},persist:async v=>{state=structuredClone(v);}};
 const a=await runClassifications(options);assert.equal(a.outcome,'deferred');assert.equal(a.failed,false);assert.equal(a.complete,false);assert.equal(a.deferred,2);assert.equal(a.results[0].operation,'verify_get');assert.equal(a.results[0].status,429);assert.equal(puts,1);assert.equal(acks.length,0);assert.ok(prepared);assert.ok(state.wikiRetryAt);
 const before=reads;const waiting=await runClassifications({...options,state});assert.equal(reads,before);assert.equal(waiting.outcome,'deferred');
 mode='recover';const b=await runClassifications({...options,state,now:new Date(Date.parse(state.wikiRetryAt)+1)});assert.equal(b.results[0].outcome,'applied');assert.equal(puts,1);assert.equal(text.split(item.videoId).length-1,1);assert.equal(acks[0].revision,1);assert.equal(acks[0].receipt.choice,'shorts');assert.equal(state.wikiRetryAt,undefined);
}));
test('Dry Run 429 never mutates Wiki, CF or state; repeated scan limits stop remaining pages',()=>temporary(async output=>{
 const state={scanIndex:0};let gets=0;
 const result=await runClassifications({env:{...env,DRY_RUN:'true'},livers:Array.from({length:5},(_,i)=>({...liver,wikiPageName:'P'+i})),cache:{},state,output,wiki:{get:async()=>{gets++;throw rateError();},put:async()=>assert.fail()},remote:async(path,data)=>{assert.equal(path,'/internal/pending');assert.equal(data,undefined);return {items:[item]};},persist:async()=>assert.fail()});
 assert.equal(gets,2);assert.equal(result.scanDeferred.length,5);assert.equal(result.results[0].outcome,'deferred');assert.equal(result.outcome,'deferred');assert.equal(result.written,false);assert.deepEqual(state,{scanIndex:0});
}));

test('all GET phases and PUT identify 429 safely; ambiguous PUT plus rate-limited verification remains unacknowledged',async()=>{
 for(const phase of ['get','conflict_get','put','verify_get']){
  let puts=0;
  await assert.rejects(guardedEdit({wiki:{get:async(p,o)=>{if(o.operation===phase)throw rateError();return puts?'after':'before';},put:async()=>{puts++;if(phase==='put')throw rateError();}},page:'P',transform:()=> 'after',save:async()=>{},dryRun:false,writeEnabled:true}),error=>{
   const info=requestErrorDetails(error);assert.equal(info.status,429);assert.equal(info.operation,phase);assert.ok(!JSON.stringify(info).includes('SECRET'));return true;
  });
  assert.equal(puts,['put','verify_get'].includes(phase)?1:0);
 }
});
test('a restored future cooldown blocks physical requests; new process after expiry can resume normally',async()=>{
 const fake=fakeGate();let calls=0;const fetcher=async()=>{calls++;return Response.json({ok:true});};
 const gate=createWikiRateLimit(fake),until=new Date(fake.clock()+600000).toISOString();gate.restore(until);
 await assert.rejects(wikiHttpClient(fetcher,{rateLimit:gate})('Wiki GET','https://example.test'));assert.equal(calls,0);
 await fake.sleep(600001);const resumed=createWikiRateLimit(fake);resumed.restore(until);
 await wikiHttpClient(fetcher,{rateLimit:resumed})('Wiki GET','https://example.test');assert.equal(calls,1);
});

test('schedule and video Wiki clients share pacing and circuit; video watermark never advances on rate deferral',()=>temporary(async output=>{
 const fake=fakeGate(),rateLimit=createWikiRateLimit(fake),times=[];let limited=false;
 const fetcher=async(url,options)=>{times.push(fake.clock());return limited?new Response('',{status:429,headers:{'Retry-After':'60'}}):Response.json(url.endsWith('/auth')?{token:'SECRET'}:{source:'body'});};
 const schedule=scheduleWikiClient(wikiHttpClient(fetcher,{rateLimit}),env),videos=videoWikiClient(env,fetcher,{rateLimit});
 assert.equal(await schedule.get(),'body');assert.equal(await videos.get('P'),'body');
 assert.deepEqual(times.map(t=>t-times[0]),[0,1000,2000,3000]);
 limited=true;await assert.rejects(schedule.get());const physical=times.length;
 const previous='2026-11-09T00:00:00Z';
 const report=await runVideos({env:{...env,YOUTUBE_API_KEY:'test'},livers:[{...liver,enabled:true}],now:new Date('2026-11-10T00:00:00Z'),state:{channels:{UC0:{lastSuccessAt:previous}}},cache:{},wiki:videos,update:async()=>{await videos.get('P');return {success:true};},persistState:async()=>{},persistCache:async()=>{},output});
 assert.equal(times.length,physical);assert.equal(report.results.UC0.success,false);assert.equal(report.channels.UC0.lastSuccessAt,previous);
}));

test('verified success is acknowledged while a later 429 is deferred, never reported as all-success',()=>temporary(async output=>{
 const external={...item,videoId:'lmnopqrstuv',key:encodeURIComponent(item.page)+':lmnopqrstuv'};const acks=[];
 const result=await runClassifications({env,livers:[liver],state:{},cache:{},output,wiki:{get:async()=>source,put:async()=>{throw rateError(60000);}},remote:async(path,data)=>{if(path==='/internal/pending')return {items:[external,item]};if(path==='/internal/ack')acks.push(...data.results);return {};},persist:async()=>{}});
 assert.equal(result.results[0].outcome,'external');assert.equal(result.results[1].outcome,'deferred');assert.equal(result.results[1].operation,'put');assert.equal(acks.length,1);assert.equal(acks[0].key,external.key);assert.equal(result.outcome,'deferred');assert.equal(result.complete,false);assert.equal(result.failed,false);
}));
