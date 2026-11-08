import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, classify } from '../../src/schedule/normalize.js';
import { formatRows, replaceSections, markers } from '../../src/schedule/formatWiki.js';
import { verify } from '../../src/schedule/verify.js';
import { sync, wikiClient, PAGE } from '../../src/schedule/sync.js';
import { httpClient } from '../../src/schedule/http.js';
import { run } from '../../src/schedule/index.js';
const fixture = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url)));
const now = new Date(fixture.now);
const env = { YOUTUBE_API_KEY: 'SECRET_KEY', TWITCH_CLIENT_ID: 'CLIENT', TWITCH_CLIENT_SECRET: 'SECRET', WIKI_PASSWORD: 'SECRET_PASSWORD', WIKI_API_BASE_URL: 'https://api.wikiwiki.jp/jigjp' };
const yt = (n = 0, extra = {}) => ({ ...fixture.youtube[1], url: `https://youtu.be/${String(n).padStart(11,'a')}`, ...extra });
const empty = { live: [], upcoming: [] };
test('normalization excludes archives, videos, invalid dates, URLs and deduplicates IDs', () => {
 const data = [yt(), yt(), yt(1,{type:'video'}), {status:'archive'},yt(2,{date:'bad'}),yt(3,{url:'https://evil.example/watch?v=abcdefghijk'}),yt(4,{url:'https://www.youtube.com.evil/watch?v=abcdefghijk'}),yt(5,{url:'https://user@youtu.be/abcdefghijk'}),yt(6,{date:'2026-11-09'})];
 const stats={};assert.equal(normalize(data,'youtube',stats).length,1);assert.equal(stats.duplicate,1);
 assert.throws(()=>normalize({},'youtube'));assert.throws(()=>normalize([{status:'live',type:'stream'}],'youtube'));
});
test('JST future-only reservations, midnight, prior-day live, limit and menu sorting', () => {
 const rows = Array.from({length:15}, (_,n)=>({...normalize([yt(n)],'youtube')[0],menuOrder:n}));
 const config=Object.fromEntries(rows.map(r=>[`youtube:${r.identity}`,{menuOrder:1}]));
 let sections=classify(rows,now,config);assert.equal(sections.upcoming.length,10);
 assert.equal(classify(rows,new Date('2026-11-09T23:59:00+09:00')).upcoming.length,0);
 const midnight={...rows[0],date:'2026-11-10T00:30:00+09:00'};
 assert.equal(classify([midnight],new Date('2026-11-09T23:59:00+09:00')).upcoming.length,0);
 assert.equal(classify([midnight],new Date('2026-11-10T00:00:00+09:00')).upcoming.length,1);
 const live=rows.map((r,n)=>({...r,status:'live',date:'2026-11-08T23:00:00+09:00',identity:'x'+n}));
 const cfg={'youtube:x14':{menuOrder:0},'youtube:x0':{menuOrder:1}};
 sections=classify(live,now,cfg);assert.equal(sections.live.length,10);assert.equal(sections.live[0].identity,'x14');assert.equal(sections.live[1].identity,'x0');
 assert.equal(classify([{...rows[0],date:now.toISOString()}],now).upcoming.length,0);
});
test('YouTube and Twitch verified starts, ended/private/changed/upcoming/premiere behavior', async () => {
 const records=[...normalize(fixture.youtube,'youtube'),...normalize(fixture.twitch,'twitch')];
 const request=async(label,url)=>fixture.responses[new URL(url).hostname];
 const verified=await verify(records,{request,env,now});assert.equal(verified.length,3);assert.equal(verified.filter(r=>r.status==='live').length,2);
 const record=records[0];
 const item=structuredClone(fixture.responses['www.googleapis.com'].items[0]);
 for(const mutate of [i=>{i.liveStreamingDetails.actualEndTime=now.toISOString();},i=>{i.snippet.liveBroadcastContent='none';}]){
  const copy=structuredClone(item);mutate(copy);assert.equal((await verify([record],{request:async()=>({items:[copy]}),env,now})).length,0);
 }
 assert.equal((await verify([record],{request:async()=>({items:[]}),env,now})).length,0);
 const upcoming=structuredClone(fixture.responses['www.googleapis.com'].items[1]);
 upcoming.liveStreamingDetails.scheduledStartTime='2026-11-10T12:00:00+09:00';
 const moved=await verify([records[1]],{request:async()=>({items:[upcoming]}),env,now});assert.equal(classify(moved,now).upcoming.length,0);
 upcoming.contentDetails.duration='PT10M';assert.equal((await verify([records[1]],{request:async()=>({items:[upcoming]}),env,now})).length,0);
 const past=structuredClone(fixture.responses['www.googleapis.com'].items[1]);past.liveStreamingDetails.scheduledStartTime='2026-11-09T10:00:00+09:00';assert.equal(classify(await verify([records[1]],{request:async()=>({items:[past]}),env,now}),now).upcoming.length,0);
 assert.equal((await verify([records[2]],{request:async label=>label==='Twitch auth'?{access_token:'token'}:{data:[]},env,now})).length,0);
 await assert.rejects(verify([record],{request:async()=>({items:[{...item,snippet:{...item.snippet,channelId:'wrong'}}]}),env,now}));
});
test('YouTube batches 50 IDs and rejects malformed response', async()=>{
 const records=normalize(Array.from({length:101},(_,n)=>yt(n)),'youtube');const sizes=[];
 await verify(records,{request:async(label,url)=>{sizes.push(new URL(url).searchParams.get('id').split(',').length);return {items:[]};},env,now});
 assert.deepEqual(sizes,[50,50,1]);await assert.rejects(verify(records,{request:async()=>({}),env,now}));
});
test('Wiki rows contain only icon/time/verified face/name linked to stream, escaped on one line',()=>{
 const row={...normalize(fixture.youtube,'youtube')[0],name:'A]]\n#evil &ref(x);',facePage:'真昼ねる/face.png',title:'HIDDEN_TITLE'};
 const out=formatRows([row],'');assert.equal(out.split('\n').length,1);assert.match(out,/25x25/);assert.match(out,/fa-youtube,#ff0033/);assert.ok(!out.includes('HIDDEN_TITLE'));assert.ok(!out.includes('#evil'));assert.ok(out.includes(row.url));
 assert.ok(!formatRows([{...row,facePage:undefined}],'').includes('&ref('));assert.throws(()=>formatRows([{...row,facePage:'evil);\n#x'}],''));
 assert.match(formatRows([{...row,platform:'twitch'}],''),/fa-twitch,#9246ff/);
});
test('markers preserve every outside byte including CRLF and refuse missing/duplicate/order/inline',()=>{
 for(const source of [fixture.source,fixture.source.replaceAll('\n','\r\n')]){
  const result=replaceSections(source,empty);
  const strip=s=>s.replace(/(\/\/ JIGWIKI_LIVE_BEGIN\r?\n)[\s\S]*?(?=\/\/ JIGWIKI_LIVE_END)/,'$1').replace(/(\/\/ JIGWIKI_UPCOMING_BEGIN\r?\n)[\s\S]*?(?=\/\/ JIGWIKI_UPCOMING_END)/,'$1');
  assert.equal(strip(result),strip(source));
 }
 for(const bad of [fixture.source.replace(markers[0],''),fixture.source+markers[0],fixture.source.replace(markers[0],'SWAP').replace(markers[1],markers[0]).replace('SWAP',markers[1]),fixture.source.replace(markers[0],'prefix'+markers[0])]) assert.throws(()=>replaceSections(bad,empty));
});
test('sync never PUTs on dry-run, disabled, unchanged, conflict or invalid markers',async()=>{
 for(const options of [{dryRun:true,writeEnabled:true},{dryRun:false,writeEnabled:false}]){
  let puts=0;await sync({wiki:{get:async()=>fixture.source,put:async()=>puts++},sections:empty,save:async()=>{},...options});assert.equal(puts,0);
 }
 const stable=replaceSections(fixture.source,empty);let puts=0;
 const options={sections:empty,dryRun:false,writeEnabled:true,save:async()=>{}};
 assert.deepEqual(await sync({...options,wiki:{get:async()=>stable,put:async()=>puts++}}),{changed:false,written:false});
 let gets=0;await assert.rejects(sync({...options,wiki:{get:async()=>gets++===0?fixture.source:fixture.source+'edit',put:async()=>puts++}}));
 await assert.rejects(sync({...options,wiki:{get:async()=>'',put:async()=>puts++}}));assert.equal(puts,0);
});
test('successful write saves backup first, rechecks before and after, exactly one PUT',async()=>{
 let source=fixture.source;const calls=[];
 const result=await sync({wiki:{get:async()=>{calls.push('GET');return source;},put:async s=>{calls.push('PUT');source=s;}},sections:empty,dryRun:false,writeEnabled:true,save:async()=>calls.push('SAVE')});
 assert.deepEqual(calls,['GET','SAVE','GET','PUT','GET']);assert.equal(result.written,true);
});
test('HTTP finite retry, timeout and no retry for ambiguous PUT; redacts errors',async()=>{
 let calls=0;let delays=[];
 const request=httpClient(async(url,opts)=>{calls++;assert.ok(opts.signal);assert.equal(opts.redirect,'error');return new Response('SECRET',{status:503});},async ms=>delays.push(ms));
 await assert.rejects(request('test','https://example.org'),e=>e.message==='test failed');assert.equal(calls,3);assert.deepEqual(delays,[1000,2000]);
 calls=0;await assert.rejects(request('PUT','https://example.org',{method:'PUT'}));assert.equal(calls,1);
});
test('Wiki client hardcodes page and validates source/base, no remote body in errors',async()=>{
 assert.throws(()=>wikiClient(()=>{}, {...env,WIKI_API_BASE_URL:'https://evil.example'}));
 const calls=[];const client=wikiClient(async(label,url,opts)=>{calls.push([label,url,opts]);return label==='Wiki auth'?{token:'TOKEN'}:{source:fixture.source};},env);
 await client.get();await client.put('source');assert.equal(calls.length,3);for(const [,url]of calls.slice(1))assert.ok(url.endsWith(encodeURIComponent(PAGE)));
});
test('integration fixture dry-run generates source/diff/report without secrets or state changes',async()=>{
 const output=await mkdtemp(join(tmpdir(),'schedule-'));
 try {
 const report=await run({env:{...env,WIKI_WRITE_ENABLED:'true',DRY_RUN:'false'},fixture,now,output,fetchImpl:async url=>new Response(JSON.stringify(fixture.responses[new URL(url).hostname]))});
 assert.equal(report.written,false);assert.equal(report.live,2);assert.equal(report.upcoming,1);
 for(const file of ['before.wiki','preview.wiki','preview.diff','report.json']){
 const text=await readFile(join(output,file),'utf8');for(const secret of ['SECRET_KEY','SECRET_PASSWORD','DEMO_TOKEN_NOT_REAL','MUST NEVER APPEAR'])assert.ok(!text.includes(secret));
 }
 }finally{await rm(output,{recursive:true,force:true});}
});
test('integration upstream/API failures abort before Wiki auth or any write',async()=>{
 const output=await mkdtemp(join(tmpdir(),'schedule-'));
 try{
 let wikiCalls=0;
 await assert.rejects(run({env,now,output,fetchImpl:async url=>{
 const u=new URL(url);if(u.hostname==='api.wikiwiki.jp')wikiCalls++;
 return new Response(JSON.stringify(u.pathname.includes('youtube.json')?fixture.youtube:u.pathname.includes('twitch.json')?fixture.twitch:{}));
 }}));assert.equal(wikiCalls,0);
 }finally{await rm(output,{recursive:true,force:true});}
});
test('existing video workflow and entrypoint remain independent from schedule',async()=>{
 const workflow=await readFile(new URL('../../.github/workflows/update-videos.yml',import.meta.url),'utf8');assert.ok(!workflow.includes('schedule/index'));
 const entry=await readFile(new URL('../../src/index.js',import.meta.url),'utf8');assert.ok(!entry.includes("console.log('YOUTUBE_API_KEY:'"));assert.ok(!entry.includes('./schedule/'));
});
test('real API reservation duration may be omitted; all configured face paths are safe', async()=>{
 const reservation=structuredClone(fixture.responses['www.googleapis.com'].items[1]);delete reservation.contentDetails.duration;
 assert.equal((await verify(normalize([fixture.youtube[1]],'youtube'),{request:async()=>({items:[reservation]}),env,now})).length,1);
 const config=JSON.parse(await readFile(new URL('../../src/schedule/config.json',import.meta.url)));
 for(const person of Object.values(config))assert.doesNotThrow(()=>formatRows([{...normalize([fixture.youtube[0]],'youtube')[0],name:person.displayName,facePage:person.facePage}],''));
});
