import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Classifier} from '../../ops/classifier/worker.mjs';
function instance(){const db=new DatabaseSync(':memory:');return new Classifier({storage:{sql:{exec(query,...args){const rows=db.prepare(query).all(...args);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}});}
const row={videoId:'abcdefghijk',line:'-01/01 [[title:https://youtu.be/abcdefghijk]]',metadata:{publishedAt:'2025-01-01T00:00:00Z',durationSeconds:30}};
const pages=[{page:'L/動画一覧',name:'L',rows:[row]}];
async function call(worker,path,data){if(data?.videoId)data.key=encodeURIComponent('L/動画一覧')+':'+data.videoId;if(data?.results)for(const result of data.results)result.key=encodeURIComponent('L/動画一覧')+':'+result.videoId;const res=await worker.fetch(new Request('https://internal'+path,{method:data?'POST':'GET',headers:{'X-Actor':'editor@example.com','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined}));return {status:res.status,...await res.json()};}
test('SQLite DO persistence, queue counts, revision conflicts, receipts, undo, history and reimport',async()=>{
 const worker=instance();assert.equal((await call(worker,'/internal/import',{pages})).status,200);
 let state=await call(worker,'/api/state');assert.equal(state.counts.unclassified,1);
 const data={videoId:row.videoId,revision:0,choice:'shorts'};
 const chosen=await call(worker,'/api/decision',data);assert.equal(chosen.item.revision,1);
 assert.equal((await call(worker,'/api/decision',data)).status,409);
 state=await call(worker,'/api/state');assert.equal(state.counts.classified,1);assert.equal(state.counts.awaiting,1);
 assert.equal((await call(worker,'/internal/pending')).items.length,1);
 assert.equal((await call(worker,'/internal/prepare',{videoId:row.videoId,revision:1,receipt:{choice:'shorts',line:row.line,location:'shorts/2025/1'}})).status,200);
 const receipt={choice:'shorts',line:row.line,location:'shorts/2025/1'};
 await call(worker,'/internal/ack',{results:[{videoId:row.videoId,revision:1,outcome:'applied',receipt}]});
 state=await call(worker,'/api/state');assert.equal(state.counts.awaiting,0);assert.equal(state.counts.unclassified,0);
 await call(worker,'/api/decision',{videoId:row.videoId,revision:1,undo:true});
 assert.equal((await call(worker,'/internal/pending')).items[0].choice,null);
 const stale=await call(worker,'/internal/ack',{results:[{videoId:row.videoId,revision:1,outcome:'external'}]});assert.deepEqual(stale.conflicts,[row.videoId]);
 await call(worker,'/internal/import',{pages});assert.equal((await call(worker,'/internal/pending')).items[0].revision,2);
 assert.equal((await call(worker,'/api/history')).events.length,3);
});
test('cancelled decisions do not block queue; missing metadata stays visible and imports are transactional',async()=>{
 const worker=instance();await call(worker,'/internal/import',{pages});
 await call(worker,'/api/decision',{videoId:row.videoId,revision:0,choice:'shorts'});
 await call(worker,'/api/decision',{videoId:row.videoId,revision:1,undo:true});
 assert.equal((await call(worker,'/internal/pending')).items.length,0);
 const before=await call(worker,'/api/state');
 const invalid=await call(worker,'/internal/import',{pages:[{...pages[0],rows:[{...row,videoId:'invalid'}]}]});assert.equal(invalid.status,409);
 assert.deepEqual((await call(worker,'/api/state')).counts,before.counts);
});
test('same video on different Wiki pages stays independent and repeated acknowledgement does not duplicate history',async()=>{
 const worker=instance();
 await call(worker,'/internal/import',{pages:[...pages,{...pages[0],page:'Other/動画一覧',name:'Other'}]});
 assert.equal((await call(worker,'/api/state')).counts.unclassified,2);
 await call(worker,'/api/decision',{videoId:row.videoId,revision:0,choice:'shorts'});
 const ack={results:[{videoId:row.videoId,revision:1,outcome:'applied',receipt:{choice:'shorts',line:row.line,location:'test'}}]};
 await call(worker,'/internal/ack',ack);await call(worker,'/internal/ack',ack);
 assert.equal((await call(worker,'/api/history')).events.length,2);
 assert.equal((await call(worker,'/api/state')).counts.unclassified,1);
});

test('missing Wiki scan/apply never deletes durable decisions, present flag, receipts, prepare journal or history',async()=>{
 const {runClassifications}=await import('../../src/classification/sync.js');
 const {WikiPageNotFoundError}=await import('../../src/services/wikiwiki.js');
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const output=await mkdtemp(join(tmpdir(),'missing-wiki-db-'));
 try {
  for(const queued of [false,true]) {
   const worker=instance();const key=encodeURIComponent(pages[0].page)+':'+row.videoId;
   await call(worker,'/internal/import',{pages});
   await call(worker,'/api/decision',{videoId:row.videoId,revision:0,choice:'shorts'});
   const receipt={choice:'shorts',line:row.line,location:'shorts/2025/1'};
   await call(worker,'/internal/ack',{results:[{videoId:row.videoId,revision:1,outcome:'applied',receipt}]});
   await call(worker,'/internal/import',{pages});
   if(queued){
    await call(worker,'/api/decision',{videoId:row.videoId,revision:1,choice:'normal'});
    await call(worker,'/internal/prepare',{videoId:row.videoId,revision:2,receipt:{...receipt,choice:'normal'}});
   }
   const before=worker.get(key);const history=await call(worker,'/api/history');const calls=[];
   const report=await runClassifications({env:{CLASSIFIER_SYNC_ENABLED:'true',DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true'},
    livers:[{name:'L',wikiPageName:pages[0].page,youtubeChannelId:'UC0',enabled:false}],cache:{UC0:[{...row.metadata,videoId:row.videoId}]},state:{},output,
    wiki:{get:async()=>{throw new WikiPageNotFoundError();},put:async()=>assert.fail('Missing pages must not be created')},
    remote:async(path,data)=>{calls.push([path,data]);const result=await call(worker,path,data);assert.equal(result.status,200);return result;},persist:async()=>{}});
   assert.ok(!calls.some(([path])=>path==='/internal/import'||path==='/internal/prepare'));
   assert.equal(report.scanSkipped.length,1);assert.equal(report.failed,queued);
   const after=worker.get(key);delete after.lastError;delete after.lastTriedAt;
   assert.deepEqual(after,before);assert.deepEqual(await call(worker,'/api/history'),history);
   if(queued){const ack=calls.find(([path])=>path==='/internal/ack')[1];assert.equal(ack.results[0].outcome,'failed');assert.equal(ack.results[0].reason,'page_not_found');}
  }
 }finally{await rm(output,{recursive:true,force:true});}
});
