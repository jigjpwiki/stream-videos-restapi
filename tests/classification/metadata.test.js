import {HttpRequestError} from '../../src/schedule/http.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Classifier} from '../../ops/classifier/worker.mjs';
import {hasPublicationDate,mergeMetadata} from '../../ops/classifier/metadata.mjs';
import {importedItem} from '../../ops/classifier/model.mjs';
import {ClassificationValidationError} from '../../src/classification/errors.js';
import {reconcileClassification,unclassifiedRows} from '../../src/classification/wiki.js';
import {runClassifications} from '../../src/classification/sync.js';
const ids=['3FpJSQazDFM','OO_EFLePEMM'],page='鈴木沙透/動画一覧';
const rows=ids.map(videoId=>({videoId,line:`-06/01 &color(red){■};[[title:https://youtu.be/${videoId}]]`,metadata:{title:'title',registeredAt:'2020-06-01T00:00:00Z'}}));
const original='**投稿動画 [#edited_videos]\n***Shorts動画 [#shorts]\n***Shorts・投稿動画未分類（自動取得） [#uncategorized]\n#fold(未分類動画一覧,close){{\n'+rows.map(r=>r.line).join('\n')+'\n}}\n';
const livers=[{name:'鈴木沙透',wikiPageName:page,youtubeChannelId:'UC0',enabled:false}];
const env={CLASSIFIER_SYNC_ENABLED:'true',DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true'};
const good=id=>({videoId:id,title:'title',publishedAt:'2023-06-01T00:00:00Z',durationSeconds:30});
const key=id=>encodeURIComponent(page)+':'+id;
async function fixture(fn){
 const output=await mkdtemp(join(tmpdir(),'metadata-'));const db=new DatabaseSync(':memory:');
 const worker=new Classifier({storage:{sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}},{CUSTODY_ENABLED:'true'});
 const remote=async(path,data)=>{const res=await worker.fetch(new Request('https://test'+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Actor':'test'},body:data?JSON.stringify(data):undefined}));assert.equal(res.status,200);return res.json();};
 let text=original,puts=0,cache={UC0:rows.map(r=>({videoId:r.videoId,...r.metadata}))};
 const wiki={get:async()=>text,put:async(p,s)=>{puts++;text=s;}};
 const options={env,livers,state:{},output,wiki,remote,details:async()=>[],persist:async()=>{},persistCache:async c=>{cache=structuredClone(c);}};
 try{await remote('/internal/import',{pages:[{page,name:'L',rows}]});for(const id of ids)for(let revision=0;revision<3;revision++)await remote('/api/decision',{key:key(id),revision,choice:id===ids[0]?'shorts':'normal'});await fn({worker,remote,options,wiki,get text(){return text;},set text(value){text=value;},get puts(){return puts;},get cache(){return cache;}});}finally{db.close();await rm(output,{recursive:true,force:true});}
}
test('fixed validation codes distinguish missing date, duplicates and absent destination without exposing source',()=>{
 const item={videoId:ids[0],choice:'shorts',revision:3,metadata:{}};
 for(const [source,metadata,code]of [[original,{},'missing_publication_date'],[original+rows[0].line,good(ids[0]),'duplicate_video_reference'],[original.replace('***Shorts動画 [#shorts]',''),good(ids[0]),'destination_section_missing']]){
  assert.throws(()=>reconcileClassification(source,{...item,metadata}),error=>error instanceof ClassificationValidationError&&error.code===code&&error.message===code);
 }
});
test('publication date merging preserves verified history but never converts registration time, MM/DD or invalid dates',()=>{
 const valid=good(ids[0]);assert.equal(mergeMetadata(valid,{publishedAt:null}).publishedAt,valid.publishedAt);
 for(const value of ['06/01','2026-02-30T00:00:00Z','garbage',null,undefined])assert.equal(hasPublicationDate({publishedAt:value}),false);
 assert.equal(hasPublicationDate(rows[0].metadata),false);assert.equal(mergeMetadata(rows[0].metadata).publishedAt,undefined);
 const old={key:key(ids[0]),videoId:ids[0],page,revision:3,choice:'shorts',metadata:valid,receipt:{choice:'normal'},prepared:{revision:3}};
 for(const authority of [undefined,'cloudflare']){const next=importedItem({...old,authority},{...rows[0],metadata:{publishedAt:null}},page,'L','now');assert.equal(next.metadata.publishedAt,valid.publishedAt);assert.equal(next.revision,3);assert.deepEqual(next.receipt,old.receipt);assert.deepEqual(next.prepared,old.prepared);}
});
test('two private videos on the same page remain pending across repeated runs; verified metadata later resumes once without changing decisions/history/receipts',()=>fixture(async f=>{
 const history=await f.remote('/api/history');
 const before=ids.map(id=>f.worker.get(key(id)));
 for(let i=0;i<2;i++){
  const report=await runClassifications({...f.options,cache:f.cache});assert.equal(report.failed,false);assert.equal(report.outcome,'deferred');assert.equal(report.complete,false);assert.equal(report.metadataWaiting,2);assert.deepEqual(report.metadataUnavailable,ids);assert.equal(f.puts,0);assert.equal(f.text,original);
  for(const id of ids){const result=report.results.find(r=>r.videoId===id);assert.equal(result.reason,'missing_publication_date');assert.equal(result.outcome,'metadata_waiting');assert.equal(result.availability,'not_returned');const item=f.worker.get(key(id)),old=before[ids.indexOf(id)];assert.equal(item.revision,3);assert.equal(item.choice,old.choice);assert.equal(item.appliedRevision,old.appliedRevision);assert.deepEqual(item.receipt,old.receipt);assert.deepEqual(item.prepared,old.prepared);}
  assert.deepEqual(await f.remote('/api/history'),history);
 }
 const a=await runClassifications({...f.options,cache:f.cache,details:async()=>[good(ids[0])]});assert.equal(a.failed,false);assert.equal(a.metadataWaiting,1);assert.equal(f.puts,1);assert.equal(f.worker.get(key(ids[0])).appliedRevision,3);assert.equal(unclassifiedRows(f.text).length,1);assert.equal(f.cache.UC0.find(v=>v.videoId===ids[0]).publishedAt,good(ids[0]).publishedAt);
 const b=await runClassifications({...f.options,cache:f.cache,details:async()=>[good(ids[1])]});assert.equal(b.outcome,'success');assert.equal(f.puts,2);assert.equal(unclassifiedRows(f.text).length,0);for(const id of ids){assert.equal(f.text.split(id).length-1,1);assert.equal(f.worker.get(key(id)).revision,3);assert.equal(f.worker.get(key(id)).appliedRevision,3);}
 await runClassifications({...f.options,cache:f.cache});assert.equal(f.puts,2);
}));
test('private API omissions reuse Worker or cached dates even when another source has partial metadata',()=>fixture(async f=>{
 for(const id of ids){const item=f.worker.get(key(id));f.worker.put({...item,metadata:{publishedAt:good(id).publishedAt}});}
 const report=await runClassifications({...f.options,cache:f.cache});assert.equal(report.failed,false);assert.equal(report.metadataWaiting,0);assert.equal(f.puts,2);assert.ok(f.text.includes('2023年'));
}));
test('missing API results do not erase cached publication dates; invalid Worker dates cannot shadow cache',()=>fixture(async f=>{
 const cache={UC0:ids.map(good)};for(const id of ids){const item=f.worker.get(key(id));f.worker.put({...item,metadata:{publishedAt:'invalid',title:'old'}});}
 const report=await runClassifications({...f.options,cache});assert.equal(report.outcome,'success');assert.equal(f.puts,2);for(const id of ids)assert.equal(f.worker.get(key(id)).metadata.publishedAt,good(id).publishedAt);
}));
test('temporary metadata API errors fail visibly instead of pretending videos are private; Dry Run never mutates DB/cache/Wiki/state',()=>fixture(async f=>{
 const history=await f.remote('/api/history');const before=JSON.stringify(ids.map(id=>f.worker.get(key(id))));const calls=[];
 const report=await runClassifications({...f.options,cache:f.cache,env:{...env,DRY_RUN:'true'},remote:async(path,data)=>{calls.push(path);assert.equal(data,undefined);return f.remote(path,data);},details:async()=>{throw Error('SECRET API failure');},persist:async()=>assert.fail(),persistCache:async()=>assert.fail()});
 assert.equal(report.failed,true);assert.equal(report.outcome,'failure');assert.equal(report.metadataWaiting,0);assert.equal(report.metadataFailures.length,2);assert.ok(report.results.every(r=>r.reason==='metadata_fetch_failed'));assert.equal(f.text,original);assert.equal(f.puts,0);assert.deepEqual(calls,['/internal/pending']);assert.equal(JSON.stringify(ids.map(id=>f.worker.get(key(id)))),before);assert.deepEqual(await f.remote('/api/history'),history);assert.ok(!JSON.stringify(report).includes('SECRET'));
}));
test('custody enabled never withdraws existing unknown-date rows, even after manual classification',()=>fixture(async f=>{
 const report=await runClassifications({...f.options,cache:f.cache,env:{...env,CLASSIFIER_CUSTODY_ENABLED:'true'}});assert.equal(report.failed,false);assert.equal(report.metadataWaiting,2);assert.equal(f.puts,0);assert.equal(f.text,original);assert.ok(report.custody.results.every(r=>r.outcome==='metadata_waiting'));for(const id of ids)assert.equal(f.worker.get(key(id)).authority,undefined);
}));

test('API authentication, quota, server and transport errors are failures, not private-video metadata waits',()=>fixture(async f=>{
 for(const error of [new HttpRequestError('YouTube','http_error',401),new HttpRequestError('YouTube','http_error',429),new HttpRequestError('YouTube','http_error',503),new HttpRequestError('YouTube','network_error'),new HttpRequestError('YouTube','invalid_response',200)]){
  const report=await runClassifications({...f.options,env:{...env,DRY_RUN:'true'},cache:f.cache,details:async()=>{throw error;}});
  assert.equal(report.failed,true);assert.equal(report.metadataWaiting,0);assert.deepEqual(report.metadataUnavailable,[]);assert.equal(report.metadataError.reason,error.code);assert.equal(report.metadataError.status,error.status);assert.ok(report.results.every(r=>r.reason==='metadata_fetch_failed'));assert.equal(f.puts,0);
 }
}));
test('metadata-only cache checkpoint failure stays visible and is not classified as an API omission',()=>fixture(async f=>{
 const report=await runClassifications({...f.options,cache:f.cache,details:async()=>ids.map(good),persistCache:async()=>{throw Error('SECRET disk failure');}});
 assert.equal(report.failed,true);assert.equal(report.metadataCacheFailed,true);assert.equal(f.puts,0);assert.ok(report.results.every(r=>r.reason==='metadata_cache_failed'));assert.deepEqual(report.metadataFailures,[]);assert.deepEqual(report.metadataUnavailable,[]);assert.equal(report.metadataWaiting,0);assert.ok(!JSON.stringify(report).includes('SECRET'));
}));

test('Dry Run custody preview preserves unknown-date rows and all durable decisions/history',()=>fixture(async f=>{
 const before=JSON.stringify(ids.map(id=>f.worker.get(key(id)))),history=await f.remote('/api/history');
 const report=await runClassifications({...f.options,env:{...env,DRY_RUN:'true',CLASSIFIER_CUSTODY_ENABLED:'true'},cache:f.cache,persist:async()=>assert.fail(),persistCache:async()=>assert.fail()});
 assert.equal(report.failed,false);assert.equal(report.custody.planned,0);assert.equal(report.metadataWaiting,2);assert.equal(f.puts,0);
 const file=(await readdir(f.options.output)).find(n=>n.endsWith('.custody-plan.preview.wiki'));assert.equal(await readFile(join(f.options.output,file),'utf8'),original);
 assert.equal(JSON.stringify(ids.map(id=>f.worker.get(key(id)))),before);assert.deepEqual(await f.remote('/api/history'),history);
}));
test('sync reports fixed duplicate/destination codes without overwriting manual Wiki content',()=>fixture(async f=>{
 for(const [text,reason]of [[original+rows[0].line,'duplicate_video_reference'],[original.replace('***Shorts動画 [#shorts]',''),'destination_section_missing']]){
  f.text=text;const report=await runClassifications({...f.options,cache:{UC0:ids.map(good)},env:{...env,DRY_RUN:'true'}});
  assert.equal(report.failed,true);assert.equal(report.results.find(r=>r.videoId===ids[0]).reason,reason);assert.equal(f.text,text);assert.equal(f.puts,0);
 }
}));
