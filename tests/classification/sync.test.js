import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HttpRequestError,requestErrorDetails} from '../../src/schedule/http.js';
import {WikiPageNotFoundError} from '../../src/services/wikiwiki.js';
import {runSync} from '../../src/sync.js';
import {runClassifications,classifierClient} from '../../src/classification/sync.js';
import {reconcileClassification} from '../../src/classification/wiki.js';
const row='-06/01 &color(red){■};[[旧タイトル:https://www.youtube.com/watch?v=abcdefghijk]]';
const source='**投稿動画 [#edited_videos]\n***Shorts動画 [#shorts]\n***Shorts・投稿動画未分類（自動取得） [#uncategorized]\n#fold(未分類動画一覧,close){{\n'+row+'\n}}\n';
const metadata={videoId:'abcdefghijk',title:'API title',publishedAt:'2023-05-31T16:00:00Z',durationSeconds:30};
const candidate={key:encodeURIComponent('L/動画一覧')+':abcdefghijk',videoId:'abcdefghijk',page:'L/動画一覧',name:'L',line:row,choice:'shorts',revision:1,metadata};
const livers=[{name:'L',wikiPageName:candidate.page,youtubeChannelId:'UC0',enabled:false}];
const env={CLASSIFIER_SYNC_ENABLED:'true',DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true'};
async function temporary(fn){const output=await mkdtemp(join(tmpdir(),'classify-'));try{return await fn(output);}finally{await rm(output,{recursive:true,force:true});}}
test('Dry Run scans historical disabled livers, downloads missing details, previews without any mutation',()=>temporary(async output=>{
 let puts=0,saves=0;const calls=[];
 const report=await runClassifications({env:{...env,DRY_RUN:'true'},livers,state:{},cache:{},output,wiki:{get:async()=>source,put:async()=>puts++},remote:async(path,data)=>{calls.push([path,data]);return {items:[{...candidate,metadata:{}}]};},details:async ids=>{assert.deepEqual(ids,['abcdefghijk']);return [metadata];},persist:async()=>saves++});
 assert.equal(puts,0);assert.equal(saves,0);assert.deepEqual(calls.map(c=>c[0]),['/internal/pending']);assert.equal(report.scanned.length,1);
 const preview=await readFile(join(output,'abcdefghijk-r1.preview.wiki'),'utf8');assert.match(preview,/#fold\(2023年/);assert.ok(preview.includes(row));
}));
test('prepares durable receipt before Wiki PUT, verifies, acknowledges then checkpoints; preserves original line',()=>temporary(async output=>{
 let text=source;const calls=[];
 const report=await runClassifications({env,livers,state:{},cache:{},output,wiki:{get:async()=>text,put:async(p,s)=>{calls.push('put');text=s;}},remote:async(path,data)=>{calls.push(path);if(path==='/internal/pending')return {items:[candidate]};if(path==='/internal/prepare')assert.equal(data.revision,1);return {conflicts:[]};},persist:async()=>calls.push('state')});
 assert.deepEqual(calls,['/internal/pending','/internal/import','/internal/prepare','put','/internal/ack','state']);assert.equal(report.failed,false);assert.equal(report.written,true);assert.equal(report.outcome,'success');assert.equal(text.split(metadata.videoId).length-1,1);assert.ok(text.includes(row));
}));
test('ambiguous PUT followed by rerun uses prepare journal to recover; stale ack is reported',()=>temporary(async output=>{
 let text=source,prepared,puts=0,first=true;
 const wiki={get:async()=>text,put:async(p,s)=>{text=s;puts++;throw Error('ambiguous');}};
 const remote=async(path,data)=>{if(path==='/internal/pending')return {items:[{...candidate,prepared}]};if(path==='/internal/prepare')prepared={revision:data.revision,receipt:data.receipt};if(path==='/internal/ack')return {conflicts:first?[]:['abcdefghijk']};return {};};
 const a=await runClassifications({env,livers,state:{},cache:{},output,wiki,remote,persist:async()=>{}});assert.equal(a.results[0].outcome,'failed');first=false;
 const b=await runClassifications({env,livers,state:{},cache:{},output,wiki,remote,persist:async()=>{}});assert.equal(puts,1);assert.equal(b.results[0].outcome,'applied');assert.equal(b.failed,true);assert.equal(text.split(metadata.videoId).length-1,1);
}));
test('one Wiki conflict does not prevent another classification; human classification is acknowledged without overwrite',()=>temporary(async output=>{
 const manual=reconcileClassification(source,{...candidate,choice:'normal'}).source;let puts=0;const receipts=[];
 const report=await runClassifications({env,livers,state:{},cache:{},output,wiki:{get:async()=>manual,put:async()=>puts++},remote:async(path,data)=>{if(path==='/internal/pending')return {items:[candidate,{...candidate,videoId:'bad'}]};if(path==='/internal/ack')receipts.push(...data.results);return {};},persist:async()=>{}});
 assert.equal(puts,0);assert.equal(report.results[0].outcome,'external');assert.equal(report.results[1].outcome,'failed');assert.equal(receipts[0].outcome,'external');
}));
test('classifier transport restricts HTTPS origin, redirects and operations; no automatic mutation retry',async()=>{
 assert.throws(()=>classifierClient({CLASSIFIER_URL:'http://example.com',CLASSIFIER_SYNC_TOKEN:'SECRET'}));
 let calls=0;const client=classifierClient({CLASSIFIER_URL:'https://editor.example.com',CLASSIFIER_SYNC_TOKEN:'SECRET'},async(url,opts)=>{calls++;assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer SECRET');return new Response('{}',{status:503});});
 await assert.rejects(client('/internal/ack',{}));assert.equal(calls,1);await assert.rejects(client('/api/decision',{}));assert.equal(calls,1);
});

// Missing scan pages are warnings; apply failures (including 404) stay retryable errors.
const fiveLivers=Array.from({length:5},(_,i)=>({name:`L${i}`,wikiPageName:`L${i}/動画一覧`,youtubeChannelId:`UC${i}`,enabled:i%2===0}));
test('one HTTP page-not-found warning among five pages succeeds, collects other four and imports no missing snapshot',()=>temporary(async output=>{
 const imported=[];const fetched=[];
 const report=await runClassifications({env,livers:fiveLivers,state:{},cache:{UC0:[metadata]},output,
  wiki:{get:async page=>{fetched.push(page);if(page===fiveLivers[0].wikiPageName)throw new WikiPageNotFoundError();return source;},put:async()=>assert.fail('Unexpected Wiki write')},
  remote:async(path,data)=>{if(path==='/internal/pending')return {items:[]};if(path==='/internal/import')imported.push(...data.pages);return {};},persist:async()=>{}});
 assert.equal(fetched.length,5);assert.equal(report.scanned.length,4);assert.equal(report.unclassifiedCount,4);
 assert.deepEqual(report.scanSkipped,[{page:fiveLivers[0].wikiPageName,reason:'page_not_found',status:404}]);assert.deepEqual(report.scanFailures,[]);
 assert.equal(report.failed,false);assert.equal(report.outcome,'success_with_warnings');assert.equal(report.written,false);
 assert.deepEqual(imported.map(p=>p.page),fiveLivers.slice(1).map(l=>l.wikiPageName));
 assert.deepEqual(JSON.parse(await readFile(join(output,'report.json'))),report);
 const combined=await runSync({env:{},runSchedule:async()=>({written:false}),applyClassifications:async()=>report});assert.equal(combined.classifications.failed,false);
}));
test('401/403, 429/5xx, timeout, network and invalid responses are failures, never page-not-found',()=>temporary(async output=>{
 for(const error of [new HttpRequestError('Wiki GET','http_error',401),new HttpRequestError('Wiki GET','http_error',403),new HttpRequestError('Wiki GET','http_error',429),new HttpRequestError('Wiki GET','http_error',503),new HttpRequestError('Wiki GET','timeout'),new HttpRequestError('Wiki GET','network_error'),new HttpRequestError('Wiki GET','invalid_response',200),new Error('SECRET_BODY')]) {
  const fetched=[];
  const report=await runClassifications({env:{...env,DRY_RUN:'true'},livers:fiveLivers,state:{},cache:{},output,
   wiki:{get:async page=>{fetched.push(page);if(page===fiveLivers[0].wikiPageName)throw error;return '';},put:async()=>assert.fail()},remote:async()=>({items:[]}),persist:async()=>assert.fail()});
  assert.equal(fetched.length,5);assert.equal(report.scanned.length,4);assert.equal(report.failed,true);assert.equal(report.outcome,'failure');assert.deepEqual(report.scanSkipped,[]);
  assert.deepEqual(report.scanFailures,[{page:fiveLivers[0].wikiPageName,...requestErrorDetails(error)}]);assert.equal(report.written,false);
  assert.ok(!(await readFile(join(output,'report.json'),'utf8')).includes('SECRET'));
 }
}));
test('all 73 pages still rotate five per run, including disabled; a created page is fetched on the next rotation',()=>temporary(async output=>{
 const all=Array.from({length:73},(_,i)=>({...fiveLivers[i%5],wikiPageName:`P${i}/動画一覧`,enabled:false}));
 let state={};let created=false;const fetched=[];
 const options={env,livers:all,cache:{},output,wiki:{get:async page=>{fetched.push(page);if(page===all[0].wikiPageName&&!created)throw new WikiPageNotFoundError();return '';},put:async()=>assert.fail()},
  remote:async path=>path==='/internal/pending'?{items:[]}: {},persist:async value=>{state=structuredClone(value);}};
 const first=await runClassifications({...options,state});assert.equal(first.scanSkipped.length,1);assert.equal(state.scanIndex,5);
 created=true;
 let latest;for(let i=0;i<14;i++)latest=await runClassifications({...options,state});
 assert.deepEqual(latest.scanSkipped,[]);assert.ok(latest.scanned.includes(all[0].wikiPageName));
 assert.equal(state.scanIndex,2);assert.equal(fetched.filter(p=>p===all[0].wikiPageName).length,2);
 assert.equal(new Set(fetched).size,73);assert.equal(fetched.length,75);
}));
test('empty existing page and existing page without section are successful empty snapshots, never missing warnings',()=>temporary(async output=>{
 const imported=[];
 const report=await runClassifications({env,livers:fiveLivers.slice(0,2),state:{},cache:{},output,wiki:{get:async page=>page===fiveLivers[0].wikiPageName?'':'本文のみ',put:async()=>assert.fail()},remote:async(path,data)=>{if(path==='/internal/pending')return {items:[]};if(path==='/internal/import')imported.push(...data.pages);return {};},persist:async()=>{}});
 assert.equal(imported.length,2);assert.ok(imported.every(p=>p.rows.length===0));assert.equal(report.failed,false);assert.equal(report.outcome,'success');assert.deepEqual(report.scanSkipped,[]);
}));
test('Dry Run with missing scan page and missing apply page never mutates Wiki, DB, cache or state; apply is not external',()=>temporary(async output=>{
 const cache={UC0:[metadata]},state={scanIndex:0},calls=[];
 const before=JSON.stringify({cache,state,candidate});
 const report=await runClassifications({env:{...env,DRY_RUN:'true'},livers,state,cache,output,wiki:{get:async()=>{throw new WikiPageNotFoundError();},put:async()=>assert.fail()},remote:async(path,data)=>{calls.push(path);assert.equal(data,undefined);assert.equal(path,'/internal/pending');return {items:[candidate]};},persist:async()=>assert.fail()});
 assert.equal(report.scanSkipped.length,1);assert.equal(report.failed,true);assert.equal(report.results[0].outcome,'failed');assert.equal(report.results[0].reason,'page_not_found');assert.equal(report.results[0].status,404);assert.equal(report.written,false);
 assert.deepEqual(calls,['/internal/pending']);assert.equal(JSON.stringify({cache,state,candidate}),before);
}));
test('aggregate respects classification outcome and preserves video failures',async()=>{
 const combined=await runSync({env:{UNIFIED_VIDEOS_ENABLED:'true'},runSchedule:async()=>({written:false}),applyClassifications:async()=>({failed:false,results:[{outcome:'applied',written:true}]}),runVideoBatch:async()=>({results:{UC0:{success:false}}})});
 assert.equal(combined.classifications.failed,false);assert.equal(combined.videos.failed,true);
 const failed=await runSync({env:{},runSchedule:async()=>({written:false}),applyClassifications:async()=>({failed:true,results:[]})});assert.equal(failed.classifications.failed,true);
});
