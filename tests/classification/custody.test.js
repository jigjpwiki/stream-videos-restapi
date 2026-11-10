import {HttpRequestError} from '../../src/schedule/http.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Classifier} from '../../ops/classifier/worker.mjs';
import {runClassifications} from '../../src/classification/sync.js';
import {updateLiverVideos} from '../../src/jobs/updateVideos.js';
import {runVideos} from '../../src/jobs/videoBatch.js';
const id='abcdefghijk',page='L/動画一覧',key=encodeURIComponent(page)+':'+id;
const line='-06/01 &color(red){■};[[人間の元タイトル:https://youtu.be/'+id+']]';
const source='**投稿動画 [#edited_videos]\n***Shorts動画 [#shorts]\n***Shorts・投稿動画未分類（自動取得） [#uncategorized]\n#fold(未分類動画一覧,close){{\n'+line+'\n}}\n***手動の節\n維持する本文\n';
const video={videoId:id,title:'API title',url:'https://www.youtube.com/watch?v='+id,publishedAt:'2023-05-31T16:00:00Z',durationSeconds:30,videoType:'uncategorized'};
const livers=[{name:'L',youtubeChannelId:'UC0',wikiPageName:page,enabled:true}];
const env={CLASSIFIER_SYNC_ENABLED:'true',CLASSIFIER_CUSTODY_ENABLED:'true',DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true'};
function database(enabled=true){const db=new DatabaseSync(':memory:');const worker=new Classifier({storage:{sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}},{CUSTODY_ENABLED:enabled?'true':'false'});return worker;}
async function request(worker,path,data){const response=await worker.fetch(new Request('https://test'+path,{method:data?'POST':'GET',headers:{'X-Actor':'editor@example.com','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined}));const result=await response.json();if(!response.ok)throw Error('Test API status '+response.status);return result;}
async function fixture(fn){const output=await mkdtemp(join(tmpdir(),'custody-'));const worker=database();let text=source,puts=0;const remote=(path,data)=>request(worker,path,data);const wiki={get:async()=>text,put:async(p,s)=>{puts++;text=s;}};const options={env,livers,state:{},cache:{UC0:[video]},output,wiki,remote,persistCache:async()=>{},persist:async()=>{}};try{return await fn({output,worker,remote,wiki,options,get text(){return text;},set text(s){text=s;},get puts(){return puts;}});}finally{await rm(output,{recursive:true,force:true});}}
test('Wiki transfer preserves exact rows/structure and history; missing Wiki row stays in durable queue; classify, undo, correct and hold publish exactly once',()=>fixture(async f=>{
 const first=await runClassifications(f.options);assert.equal(first.custody.withdrawn,1);assert.ok(!f.text.includes(id));assert.equal(f.text,source.replace(line+'\n',''));
 let item=f.worker.get(key);assert.equal(item.line,line);assert.equal(item.custody.phase,'committed');assert.equal(item.revision,0);assert.equal(item.present,true);
 const next=await runClassifications(f.options);assert.equal(next.failed,false);assert.equal(f.worker.get(key).present,true);assert.equal((await f.remote('/api/state')).items.length,1);
 async function choose(choice,undo=false){item=f.worker.get(key);await f.remote('/api/decision',{key,revision:item.revision,choice,undo});const report=await runClassifications(f.options);assert.equal(report.failed,false);}
 await choose('shorts');assert.ok(f.text.includes(line));assert.ok(f.text.includes('#fold(2023年'));assert.ok(f.text.includes('#fold(6月'));assert.equal(f.text.split(id).length-1,1);
 await choose(null,true);assert.ok(!f.text.includes(id));assert.equal(f.worker.get(key).choice,null);
 await choose('normal');assert.ok(f.worker.get(key).receipt.location.includes('投稿動画'));assert.ok(f.text.includes(line));
 await choose('shorts');assert.equal(f.text.split(id).length-1,1);
 await choose('hold');assert.ok(!f.text.includes(id));assert.equal(f.worker.get(key).choice,'hold');
 await choose(null,true);assert.ok(f.text.includes(line));assert.equal(f.worker.get(key).choice,'shorts');
 assert.ok((await f.remote('/api/history')).events.length>=10);assert.equal(f.worker.get(key).custody.line,line);
 const totals=await f.remote('/internal/custody-status');assert.equal(totals.wikiTransfersCommitted,1);assert.equal(totals.preparedRemaining,0);
}));
test('Wiki PUT response loss and commit response loss recover idempotently with at least one complete copy',()=>fixture(async f=>{
 let losePut=true;const actualPut=f.wiki.put;f.wiki.put=async(p,s)=>{await actualPut(p,s);if(losePut){losePut=false;throw Error('lost');}};
 const a=await runClassifications(f.options);assert.equal(a.failed,false);assert.ok(!f.text.includes(id));assert.equal(f.worker.get(key).line,line);assert.equal(f.worker.get(key).custody.phase,'committed');
 const b=await runClassifications(f.options);assert.equal(b.failed,false);assert.equal(f.puts,1);assert.equal(f.worker.get(key).custody.phase,'committed');
 const files=await readdir(f.output);const backups=files.filter(n=>n.endsWith('.before.wiki')&&n.includes('.custody.'));assert.ok(backups.length>=1);assert.ok((await Promise.all(backups.map(n=>readFile(join(f.output,n),'utf8')))).includes(source));
}));
test('human edit after prepare aborts withdrawal, preserves full durable record and leaves conflict pending',()=>fixture(async f=>{
 const remote=f.options.remote;let inject=false;
 f.options.remote=async(path,data)=>{const result=await remote(path,data);if(path==='/internal/custody'&&data.operation==='prepare')inject=true;return result;};
 const get=f.wiki.get;f.wiki.get=async()=>{if(inject){inject=false;f.text+='人間の追記\n';}return get();};
 const report=await runClassifications(f.options);assert.equal(report.failed,true);assert.ok(f.text.includes(line));assert.ok(f.text.includes('人間の追記'));assert.equal(f.puts,0);assert.equal(f.worker.get(key).line,line);
 const again=await runClassifications(f.options);assert.equal(again.failed,true);assert.equal(f.puts,0);
}));
test('Cloudflare failure before storage leaves Wiki untouched; migration switch defaults off',()=>fixture(async f=>{
 const offline=await runClassifications({...f.options,remote:async(path,data)=>{if(path==='/internal/import')throw Error('offline');return f.remote(path,data);}});assert.equal(offline.failed,true);assert.equal(offline.importFailed,true);assert.equal(f.text,source);assert.equal(f.worker.get(key),null);
 const disabled=database(false);await assert.rejects(request(disabled,'/internal/custody',{operation:'register',page,name:'L',row:{videoId:id,line,metadata:video}}));
 const normal=await runClassifications({...f.options,env:{...env,CLASSIFIER_CUSTODY_ENABLED:'false'}});assert.equal(normal.custody.enabled,false);assert.equal(f.text,source);
}));
test('Dry Run covers all 73 pages with bounded metadata, no DB/Wiki/state writes and reviewable withdrawal diffs',()=>fixture(async f=>{
 const all=Array.from({length:73},(_,i)=>({...livers[0],wikiPageName:`L${i}/動画一覧`,enabled:false}));let reads=0;
 const report=await runClassifications({...f.options,livers:all,env:{...env,DRY_RUN:'true',CLASSIFIER_SCAN_ALL:'true'},wiki:{get:async()=>{reads++;return source;},put:async()=>assert.fail()},remote:async(path,data)=>{assert.equal(path,'/internal/pending');assert.equal(data,undefined);return {items:[]};},persist:async()=>assert.fail()});
 assert.equal(report.scanned.length,73);assert.equal(report.custody.planned,73);assert.equal(report.unclassifiedCount,73);assert.equal(reads,73);assert.equal(report.written,false);assert.equal(report.failed,false);assert.equal(f.worker.get(key),null);
 assert.ok((await readdir(f.output)).some(n=>n.endsWith('.diff')));
}));
test('new uncertain video goes directly to durable queue; re-fetch never resurrects migrated/managed video or overwrites classification',()=>fixture(async f=>{
 f.text=source.replace(line+'\n','');const cache={};const opts={wiki:f.wiki,cache,output:f.output,dryRun:false,writeEnabled:true,classifier:f.remote,fetchVideos:async()=>[video]};
 const result=await updateLiverVideos(livers[0],'test',opts);assert.equal(result.success,true);assert.equal(f.puts,0);assert.equal(f.worker.get(key).authority,'cloudflare');assert.ok(!f.text.includes(id));
 await f.remote('/api/decision',{key,revision:0,choice:'shorts'});
 await updateLiverVideos(livers[0],'test',{...opts,fetchVideos:async()=>[{...video,videoType:'normal',title:'different'}]});assert.ok(!f.text.includes(id));assert.equal(f.worker.get(key).choice,'shorts');
 const published=await runClassifications(f.options);assert.equal(published.failed,false);assert.equal(f.text.split(id).length-1,1);assert.ok(f.text.includes('API title'));
}));
test('Cloudflare outage checkpoints complete outbox, never advances watermark, replays outbox beyond API lookback; Dry Run is immutable',()=>fixture(async f=>{
 f.text=source.replace(line+'\n','');let savedCache={},savedState={channels:{UC0:{lastSuccessAt:'2020-01-01T00:00:00Z'}}};let offline=true;
 const remote=async(path,data)=>{if(offline)throw Error('offline');return f.remote(path,data);};
 const run=async(videos,dryRun=false)=>runVideos({env:{...env,YOUTUBE_API_KEY:'test',CLASSIFIER_URL:'https://classifier.example',CLASSIFIER_SYNC_TOKEN:'s',DRY_RUN:dryRun?'true':'false'},livers,state:savedState,cache:savedCache,wiki:f.wiki,output:f.output,
 update:(l,k,o)=>updateLiverVideos(l,k,{...o,classifier:remote,fetchVideos:async()=>videos}),persistCache:async value=>{savedCache=structuredClone(value);},persistState:async value=>{savedState=structuredClone(value);}});
 const failed=await run([video]);assert.equal(failed.results.UC0.success,false);assert.equal(savedState.channels.UC0.lastSuccessAt,'2020-01-01T00:00:00Z');assert.equal(savedCache.UC0[0].pendingIngestion,true);assert.equal(savedCache.UC0[0].publishedAt,video.publishedAt);
 offline=false;const recovered=await run([]);assert.equal(recovered.results.UC0.success,true);assert.equal(f.worker.get(key).custody.origin,'new');assert.equal(savedCache.UC0[0].pendingIngestion,false);assert.ok(!f.text.includes(id));
 const before=JSON.stringify({savedCache,savedState,item:f.worker.get(key)});await run([{...video,videoId:'01234567890',url:'https://www.youtube.com/watch?v=01234567890'}],true);assert.equal(JSON.stringify({savedCache,savedState,item:f.worker.get(key)}),before);assert.equal(f.worker.get(encodeURIComponent(page)+':01234567890'),null);
}));
test('commit response loss is safe; cumulative durable count reconciles a previously withdrawn Wiki row',()=>fixture(async f=>{
 const base=f.options.remote;let lose=true;
 f.options.remote=async(path,data)=>{const result=await base(path,data);if(path==='/internal/custody'&&data.operation==='commit'&&lose){lose=false;throw Error('lost commit response');}return result;};
 const first=await runClassifications(f.options);assert.equal(first.failed,true);assert.equal(f.worker.get(key).custody.phase,'committed');assert.ok(!f.text.includes(id));
 const retry=await runClassifications(f.options);assert.equal(retry.failed,false);assert.equal(f.puts,1);assert.equal(retry.custody.totals.wikiTransfersCommitted,1);
}));
test('verification or checkpoint failure prevents Wiki withdrawal; prepared copy survives failed PUT',()=>fixture(async f=>{
 const base=f.options.remote;let staged=false;
 f.options.remote=async(path,data)=>{const result=await base(path,data);if(path==='/internal/custody'&&data.operation==='prepare')staged=true;if(staged&&path.startsWith('/internal/item'))return {item:{...result.item,metadata:{}}};return result;};
 const badVerify=await runClassifications(f.options);assert.equal(badVerify.failed,true);assert.equal(f.puts,0);assert.equal(f.text,source);
 f.options.remote=base;const noCheckpoint=await runClassifications({...f.options,persistCache:async()=>{throw Error('disk full');}});assert.equal(noCheckpoint.failed,true);assert.equal(f.puts,0);assert.equal(f.text,source);
 f.wiki.put=async()=>{throw Error('Wiki unavailable');};const failed=await runClassifications(f.options);assert.equal(failed.failed,true);assert.equal(f.text,source);assert.equal(f.worker.get(key).line,line);
}));
test('human Wiki classification/edit is authoritative and never duplicated, including after cloud-managed publish',()=>fixture(async f=>{
 await runClassifications(f.options);f.text+='-06/01 [[人間の分類:https://youtu.be/'+id+']]\n';
 await f.remote('/api/decision',{key,revision:0,choice:'shorts'});const result=await runClassifications(f.options);assert.equal(result.results[0].outcome,'external');assert.equal(f.text.split(id).length-1,1);assert.ok(f.text.includes('人間の分類'));assert.equal(f.worker.get(key).custody.line,line);
 await assert.rejects(f.remote('/api/decision',{key,revision:1,choice:'normal'}));
}));
test('registration response loss retries without duplicates, and cache marker prevents legacy ingestion resurrecting a managed video',()=>fixture(async f=>{
 f.text=source.replace(line+'\n','');const cache={};let lose=true;
 const remote=async(path,data)=>{const result=await f.remote(path,data);if(path==='/internal/custody'&&data.operation==='register'&&lose){lose=false;throw Error('lost');}return result;};
 const options={wiki:f.wiki,cache,output:f.output,dryRun:false,writeEnabled:true,classifier:remote,fetchVideos:async()=>[video]};
 await assert.rejects(updateLiverVideos(livers[0],'test',options));assert.equal(f.worker.get(key).line.includes(id),true);assert.equal(cache.UC0[0].pendingIngestion,true);
 await updateLiverVideos(livers[0],'test',options);assert.equal(cache.UC0[0]._cloudflareManaged,true);
 await updateLiverVideos(livers[0],'test',{...options,classifier:undefined,custodyEnabled:false});assert.ok(!f.text.includes(id));assert.equal((await f.remote('/api/state')).items.length,1);
}));
test('legacy schema/revisions/receipts/history remain intact while transfer adds custody fields; live batch size bounds withdrawals',()=>fixture(async f=>{
 await f.remote('/internal/import',{pages:[{page,name:'L',rows:[{videoId:id,line,metadata:video}]}]});
 await f.remote('/api/decision',{key,revision:0,choice:'hold'});
 f.worker.put({...f.worker.get(key),receipt:{choice:'shorts',line,location:'old'},prepared:{revision:0,receipt:{choice:'shorts',line,location:'old'}}});
 const before=f.worker.get(key),history=(await f.remote('/api/history')).events;
 await runClassifications({...f.options,env:{...env,CLASSIFIER_CUSTODY_BATCH_SIZE:'1'}});
 const after=f.worker.get(key);assert.equal(after.revision,before.revision);assert.equal(after.choice,before.choice);assert.equal(after.line,before.line);assert.deepEqual(after.receipt,before.receipt);assert.deepEqual(after.prepared,before.prepared);assert.deepEqual((await f.remote('/api/history')).events,history);
}));
test('a failed transfer pauses other writes to the same page, then safely resumes without stale page hashes',()=>fixture(async f=>{
 const second={...video,videoId:'01234567890',url:'https://www.youtube.com/watch?v=01234567890'};const secondLine='-06/02 [[second:https://youtu.be/01234567890]]';f.text=f.text.replace(line+'\n',line+'\n'+secondLine+'\n');
 f.options.cache={UC0:[video,second]};let fail=true;const put=f.wiki.put;
 f.wiki.put=async(p,s)=>{if(fail){fail=false;throw Error('unavailable');}await put(p,s);};
 const first=await runClassifications(f.options);assert.equal(first.failed,true);assert.ok(f.text.includes(line));assert.ok(f.text.includes(secondLine));assert.equal(f.puts,0);
 await assert.rejects(updateLiverVideos(livers[0],'test',{wiki:f.wiki,cache:{},output:f.output,dryRun:false,writeEnabled:true,classifier:f.remote,fetchVideos:async()=>[{...video,videoType:'normal'}]}));assert.equal(f.puts,0);
 const retry=await runClassifications(f.options);assert.equal(retry.failed,false);assert.equal(retry.custody.withdrawn,2);assert.ok(!f.text.includes(id));assert.ok(!f.text.includes(second.videoId));
}));
test('previously confirmed classification is retained and scheduled for re-publication after transfer without changing revision',()=>fixture(async f=>{
 await f.remote('/internal/import',{pages:[{page,name:'L',rows:[{videoId:id,line,metadata:video}]}]});
 await f.remote('/api/decision',{key,revision:0,choice:'shorts'});
 await f.remote('/internal/ack',{results:[{key,videoId:id,revision:1,outcome:'applied',receipt:{choice:'shorts',line,location:'old'}}]});
 await runClassifications(f.options);assert.equal(f.worker.get(key).choice,'shorts');assert.equal(f.worker.get(key).revision,1);assert.equal(f.worker.get(key).needsPublication,true);
 const next=await runClassifications(f.options);assert.equal(next.failed,false);assert.equal(f.worker.get(key).needsPublication,false);assert.equal(f.text.split(id).length-1,1);
}));
test('bounded direct ingest keeps remaining records in outbox and resumes without registering duplicates',()=>fixture(async f=>{
 f.text=source.replace(line+'\n','');const videos=[video,{...video,videoId:'01234567890',url:'https://www.youtube.com/watch?v=01234567890'}],cache={};
 const options={wiki:f.wiki,cache,output:f.output,dryRun:false,writeEnabled:true,classifier:f.remote,ingestionLimit:1,fetchVideos:async()=>videos};
 await assert.rejects(updateLiverVideos(livers[0],'test',options));assert.equal((await f.remote('/api/state')).items.length,1);assert.equal(cache.UC0.length,2);assert.ok(cache.UC0.some(v=>v.pendingIngestion));
 await updateLiverVideos(livers[0],'test',{...options,fetchVideos:async()=>[]});assert.equal((await f.remote('/api/state')).items.length,2);assert.ok(cache.UC0.every(v=>!v.pendingIngestion));assert.ok(!f.text.includes(id));
}));
test('migration removes only the selected CRLF row and preserves headings, folds and unrelated bytes',()=>fixture(async f=>{
 const before=source.replaceAll('\n','\r\n');f.text=before;
 const report=await runClassifications(f.options);assert.equal(report.failed,false);assert.equal(report.written,true);assert.equal(f.text,before.replace(line+'\r\n',''));assert.equal(f.worker.get(key).line,line);
}));
test('human-authoritative Cloudflare records stay in classified/history view and never block the unclassified queue',()=>fixture(async f=>{
 await runClassifications(f.options);f.worker.put({...f.worker.get(key),outcome:'external',choice:null});
 const queue=await f.remote('/api/state');assert.equal(queue.items.length,0);assert.equal(queue.counts.unclassified,0);assert.equal(queue.counts.classified,1);
 const history=await f.remote('/api/state?mode=classified');assert.equal(history.items[0].key,key);
}));

test('429 after classification PUT preserves durable revision, receipt, history and prepare journal until verification on rerun',()=>fixture(async f=>{
 await runClassifications(f.options);
 await f.remote('/api/decision',{key,revision:0,choice:'shorts'});
 const before=f.worker.get(key),history=await f.remote('/api/history');
 const get=f.wiki.get;f.wiki.get=async(p,o)=>{if(o?.operation==='verify_get')throw new HttpRequestError('Wiki GET','http_error',429,120000);return get();};
 const limited=await runClassifications(f.options);
 assert.equal(limited.outcome,'deferred');assert.equal(limited.writeUnverified,true);assert.equal(limited.writeAttempted,true);
 const pending=f.worker.get(key);assert.equal(pending.revision,before.revision);assert.equal(pending.appliedRevision,before.appliedRevision);assert.deepEqual(pending.receipt,before.receipt);assert.equal(pending.prepared.revision,pending.revision);assert.deepEqual(await f.remote('/api/history'),history);
 const puts=f.puts;f.wiki.get=get;
 const recovered=await runClassifications(f.options);assert.equal(recovered.failed,false);assert.equal(recovered.outcome,'success');assert.equal(f.puts,puts);assert.equal(f.worker.get(key).appliedRevision,1);assert.equal(f.worker.get(key).receipt.choice,'shorts');assert.equal(f.text.split(id).length-1,1);
}));
