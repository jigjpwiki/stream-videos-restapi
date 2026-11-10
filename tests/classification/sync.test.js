import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
 assert.deepEqual(calls,['/internal/pending','/internal/import','/internal/prepare','put','/internal/ack','state']);assert.equal(report.failed,false);assert.equal(text.split(metadata.videoId).length-1,1);assert.ok(text.includes(row));
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
