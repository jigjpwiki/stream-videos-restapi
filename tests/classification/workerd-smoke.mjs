// Build first: npm run classifier:bundle. Uses a real local workerd SQLite DO, no deploy.
import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'classifier-workerd-'));
const options={modules:true,scriptPath:resolve('work/classifier-bundle/worker.js'),compatibilityDate:'2026-07-30',durableObjects:{CLASSIFIER:{className:'Classifier',useSQLite:true}},durableObjectsPersist:dir,bindings:{ACCESS_ISSUER:'https://test-team.cloudflareaccess.com',ACCESS_AUD:'test-aud',EDITOR_EMAILS:'editor@example.com',SYNC_TOKEN:'s'.repeat(40),CUSTODY_ENABLED:'true'}};
let mf;
try {
 mf=new Miniflare(options);
 const request=(path,data,token='s'.repeat(40))=>mf.dispatchFetch('https://editor.example.com'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
 assert.equal((await request('/internal/pending',null,'wrong')).status,401);
 assert.equal((await request('/api/state')).status,401);
 const row={videoId:'abcdefghijk',line:'-01/01 [[title:https://youtu.be/abcdefghijk]]'};
 assert.equal((await request('/internal/import',{pages:[{page:'L/動画一覧',name:'L',rows:[row]}]})).status,200);
 let ns=await mf.getDurableObjectNamespace('CLASSIFIER');let stub=ns.get(ns.idFromName('wiki-video-classifier-v1'));
 let res=await stub.fetch('https://private/api/decision',{method:'POST',headers:{'Content-Type':'application/json','X-Actor':'test@example.com'},body:JSON.stringify({key:encodeURIComponent('L/動画一覧')+':'+row.videoId,videoId:row.videoId,revision:0,choice:'shorts'})});assert.equal(res.status,200);
 assert.equal((await (await request('/internal/pending')).json()).items.length,1);
 const direct={videoId:'01234567890',line:'-01/01 [[new:https://youtu.be/01234567890]]',metadata:{publishedAt:'2025-01-01T00:00:00Z'}};
 assert.equal((await request('/internal/custody',{operation:'register',page:'L/動画一覧',name:'L',row:direct})).status,200);
 await mf.dispose();mf=new Miniflare(options);
 assert.equal((await (await request('/internal/pending')).json()).items[0].choice,'shorts');
 const stored=await(await request('/internal/item?key='+encodeURIComponent(encodeURIComponent('L/動画一覧')+':01234567890'))).json();assert.equal(stored.item.authority,'cloudflare');assert.equal(stored.item.line,direct.line);
 const waitKey=encodeURIComponent('L/動画一覧')+':'+row.videoId;
 assert.equal((await request('/internal/metadata-wait',{items:[{key:waitKey,revision:1}]},'wrong')).status,401);
 const beforeWait=(await(await request('/internal/item?key='+encodeURIComponent(waitKey))).json()).item;
 assert.equal((await request('/internal/metadata-wait',{items:[{key:waitKey,revision:1}]})).status,200);
 await mf.dispose();mf=new Miniflare(options);
 const afterWait=(await(await request('/internal/item?key='+encodeURIComponent(waitKey))).json()).item;
 const {metadataRetry,...unchanged}=afterWait;const {metadataRetry:oldRetry,...beforeCore}=beforeWait;assert.deepEqual(unchanged,beforeCore);assert.equal(metadataRetry.revision,1);
 const waitingQueue=await(await request('/internal/pending')).json();assert.equal(waitingQueue.metadataWaiting,1);assert.ok(!waitingQueue.items.some(i=>i.key===waitKey));
 ns=await mf.getDurableObjectNamespace('CLASSIFIER');stub=ns.get(ns.idFromName('wiki-video-classifier-v1'));
 res=await stub.fetch('https://private/api/decision',{method:'POST',headers:{'Content-Type':'application/json','X-Actor':'test@example.com'},body:JSON.stringify({key:waitKey,revision:1,choice:'normal'})});assert.equal(res.status,200);
 assert.ok((await(await request('/internal/pending')).json()).items.some(i=>i.key===waitKey));
 console.log('workerd: authentication boundary, SQLite persistence, durable metadata retry and queue passed');
}finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true});}
