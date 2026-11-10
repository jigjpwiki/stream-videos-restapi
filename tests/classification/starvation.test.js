import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Classifier} from '../../ops/classifier/worker.mjs';
import {decide,importedItem} from '../../ops/classifier/model.mjs';
import {runClassifications} from '../../src/classification/sync.js';
import {unclassifiedRows} from '../../src/classification/wiki.js';
const page='L/動画一覧',key=id=>encodeURIComponent(page)+':'+id;
const ids=Array.from({length:50},(_,i)=>'a'+String(i).padStart(10,'0')),goodId='zzzzzzzzzzz';
const line=id=>`-06/01 &color(red){■};[[title:https://youtu.be/${id}]]`;
const detail=id=>({videoId:id,title:'title',publishedAt:'2023-06-01T00:00:00Z',durationSeconds:30});
const source='**投稿動画 [#edited_videos]\n***Shorts動画 [#shorts]\n***Shorts・投稿動画未分類（自動取得） [#uncategorized]\n#fold(未分類動画一覧,close){{\n'+[...ids,goodId].map(line).join('\n')+'\n}}\n';
const env={CLASSIFIER_SYNC_ENABLED:'true',DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true'};
async function fixture(fn){
 const output=await mkdtemp(join(tmpdir(),'starvation-')),db=new DatabaseSync(':memory:');
 const worker=new Classifier({storage:{sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}},{});
 const remote=async(path,data)=>{const res=await worker.fetch(new Request('https://test'+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Actor':'test'},body:data?JSON.stringify(data):undefined}));assert.equal(res.status,200);return res.json();};
 for(const id of [...ids,goodId]){let item=importedItem(null,{videoId:id,line:line(id),metadata:id===goodId?detail(id):{}},page,'L','2026-01-01T00:00:00Z');item=decide(item,{revision:0,choice:'shorts'},'test','2026-01-01T00:00:00Z');if(id!==goodId){item.receipt={choice:'normal',line:line(id),location:'old'};item.prepared={revision:1,receipt:{choice:'shorts',line:line(id),location:'prepared'}};}worker.put(item);}
 let text=source,puts=0,calls=0;
 const options={env,livers:[{name:'L',wikiPageName:page,youtubeChannelId:'UC0',enabled:false}],cache:{},state:{},output,remote,wiki:{get:async()=>text,put:async(p,s)=>{puts++;text=s;}},details:async()=>{calls++;return [];},persist:async()=>{},persistCache:async()=>{}};
 try{await fn({worker,remote,options,get text(){return text;},get puts(){return puts;},get calls(){return calls;}});}finally{db.close();await rm(output,{recursive:true,force:true});}
}
function core(item){const {metadataRetry,metadata,updatedAt,...rest}=item;return rest;}
test('50 metadata waits release the 51st healthy item on the next run; scanned waits do not cause repeat YouTube calls',()=>fixture(async f=>{
 const before=ids.map(id=>core(f.worker.get(key(id)))),history=await f.remote('/api/history');
 const first=await runClassifications(f.options);assert.equal(first.metadataWaiting,50);assert.equal(first.failed,false);assert.equal(f.calls,1);assert.equal(f.puts,0);
 const pending=await f.remote('/internal/pending');assert.deepEqual(pending.items.map(i=>i.videoId),[goodId]);assert.equal(pending.metadataWaiting,50);
 for(let i=0;i<50;i++){const item=f.worker.get(key(ids[i]));assert.deepEqual(core(item),before[i]);assert.equal(item.metadataRetry.revision,1);assert.equal(Date.parse(item.metadataRetry.nextCheckAt)-Date.parse(item.metadataRetry.checkedAt),6*3600000);}
 assert.deepEqual(await f.remote('/api/history'),history);
 const second=await runClassifications(f.options);assert.equal(second.failed,false);assert.equal(second.metadataWaitingScheduled,50);assert.equal(second.outcome,'deferred');assert.equal(second.complete,false);assert.equal(f.puts,1);assert.equal(f.worker.get(key(goodId)).appliedRevision,1);assert.equal(f.text.split(goodId).length-1,1);
 await runClassifications(f.options);assert.equal(f.calls,1);assert.equal(f.puts,1);assert.equal(unclassifiedRows(f.text).length,50);
}));
test('expired waits retry once and resume at the same revision; notifications are CAS/idempotent and new decisions or verified imports reset waiting',()=>fixture(async f=>{
 await runClassifications(f.options);const initial=f.worker.get(key(ids[0]));
 await f.remote('/internal/metadata-wait',{items:[{key:key(ids[0]),revision:1}]});assert.deepEqual(f.worker.get(key(ids[0])).metadataRetry,initial.metadataRetry);
 f.worker.put({...initial,metadataRetry:{...initial.metadataRetry,nextCheckAt:'2000-01-01T00:00:00Z'}});
 let requested;const report=await runClassifications({...f.options,details:async values=>{requested=values;return [detail(ids[0])];}});
 assert.deepEqual(requested,[ids[0]]);assert.equal(report.failed,false);assert.equal(f.worker.get(key(ids[0])).appliedRevision,1);assert.equal(f.text.split(ids[0]).length-1,1);
 await f.remote('/api/decision',{key:key(ids[1]),revision:1,choice:'normal'});
 assert.equal(f.worker.get(key(ids[1])).metadataRetry,null);
 const stale=await f.remote('/internal/metadata-wait',{items:[{key:key(ids[1]),revision:1}]});assert.deepEqual(stale.conflicts,[key(ids[1])]);assert.equal(f.worker.get(key(ids[1])).metadataRetry,null);
 const rows=unclassifiedRows(f.text).map(r=>({...r,metadata:r.videoId===ids[2]?detail(ids[2]):{}}));
 await f.remote('/internal/import',{pages:[{page,name:'L',rows}]});assert.equal(f.worker.get(key(ids[2])).metadataRetry,null);
 await f.remote('/internal/metadata-wait',{items:[{key:key(ids[2]),revision:1}]});assert.equal(f.worker.get(key(ids[2])).metadataRetry,null);
 const pending=await f.remote('/internal/pending');assert.ok(pending.items.some(i=>i.videoId===ids[1]));assert.ok(pending.items.some(i=>i.videoId===ids[2]));
}));
test('Dry Run with 51 candidates writes no wait markers, decisions, histories, cache, cursor or Wiki',()=>fixture(async f=>{
 const before=[...ids,goodId].map(id=>f.worker.get(key(id))),history=await f.remote('/api/history');
 const report=await runClassifications({...f.options,env:{...env,DRY_RUN:'true'},persist:async()=>assert.fail(),persistCache:async()=>assert.fail(),remote:async(path,data)=>{assert.ok(['/internal/pending','/internal/lookup'].includes(path));return f.remote(path,data);}});
 assert.equal(report.metadataWaiting,50);assert.equal(f.puts,0);assert.deepEqual([...ids,goodId].map(id=>f.worker.get(key(id))),before);assert.deepEqual(await f.remote('/api/history'),history);
}));
test('wait notification failure is visible without changing decisions; legacy Worker receives no unsupported mutation',()=>fixture(async f=>{
 const before=ids.map(id=>core(f.worker.get(key(id))));let notifications=0;
 const failed=await runClassifications({...f.options,remote:async(path,data)=>{if(path==='/internal/metadata-wait'){notifications++;throw Error('SECRET');}return f.remote(path,data);}});
 assert.equal(notifications,1);assert.equal(failed.failed,true);assert.equal(failed.metadataWaitUpdateFailed,true);assert.ok(!JSON.stringify(failed).includes('SECRET'));assert.deepEqual(ids.map(id=>core(f.worker.get(key(id)))),before);
 const legacy=await runClassifications({...f.options,remote:async(path,data)=>{assert.notEqual(path,'/internal/metadata-wait');const result=await f.remote(path,data);if(path==='/internal/pending'){delete result.metadataWaitSupported;delete result.metadataWaiting;}return result;}});
 assert.equal(legacy.failed,false);assert.equal(legacy.metadataWaitUnsupported,true);assert.equal(legacy.outcome,'deferred');assert.equal(f.puts,0);
}));
