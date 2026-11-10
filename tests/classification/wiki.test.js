import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unclassifiedRows,reconcileClassification} from '../../src/classification/wiki.js';
import {importedItem,decide,pending,acknowledge} from '../../ops/classifier/model.mjs';
const line='-01/01 &color(red){■};[[手動で編集したタイトル:https://youtu.be/abcdefghijk]]';
const source='**投稿動画 [#edited_videos]\n***Shorts動画 [#shorts]\n***Shorts・投稿動画未分類（自動取得） [#uncategorized]\n#fold(未分類動画一覧,close){{\n'+line+'\n}}\n***別の節\n本文\n';
const item={videoId:'abcdefghijk',choice:'shorts',metadata:{publishedAt:'2024-12-31T16:00:00Z',title:'API title',durationSeconds:30},revision:1};
test('collects historical uncategorized only, moves exact original row to metadata JST year/month and keeps unrelated text',()=>{
 assert.equal(unclassifiedRows(source).length,1);
 for(const eol of ['\n','\r\n']){
 const original=source.replaceAll('\n',eol),result=reconcileClassification(original,item);
 assert.equal(result.source.split(item.videoId).length-1,1);assert.ok(result.source.includes(line));assert.ok(result.source.includes("#fold(2025年"));assert.ok(result.source.includes('#fold(1月'));
 assert.equal(unclassifiedRows(result.source).length,0);assert.ok(result.source.endsWith('***別の節'+eol+'本文'+eol));
 if(eol==='\r\n')assert.ok(!/(?<!\r)\n/.test(result.source));
 }
});
test('normal correction and undo can move only unchanged rows previously applied by this system',()=>{
 const shorts=reconcileClassification(source,item);
 const normal=reconcileClassification(shorts.source,{...item,choice:'normal',receipt:shorts.receipt});
 assert.equal(normal.source.split(item.videoId).length-1,1);assert.match(normal.receipt.location,/投稿動画.*2025年/);
 const undo=reconcileClassification(normal.source,{...item,choice:'uncategorized',receipt:normal.receipt});assert.equal(unclassifiedRows(undo.source).length,1);assert.ok(undo.source.includes(line));
 const humanEdited=shorts.source.replace('手動で編集したタイトル','人間の変更');
 assert.equal(reconcileClassification(humanEdited,{...item,choice:'normal',receipt:shorts.receipt}).outcome,'external');
 const humanMoved=shorts.source.replace('2025年','2024年');
 assert.equal(reconcileClassification(humanMoved,{...item,choice:'normal',receipt:shorts.receipt}).outcome,'external');
});
test('manual Wiki classification wins; duplicates, missing metadata/target fail closed; no guessed year',()=>{
 const moved=reconcileClassification(source,item).source;
 assert.deepEqual(reconcileClassification(moved,{...item,choice:'normal'}),{source:moved,outcome:'external',receipt:null});
 assert.throws(()=>reconcileClassification(source+line,item));
 assert.throws(()=>reconcileClassification(source,{...item,metadata:{}}));
 assert.throws(()=>reconcileClassification(source.replace('***Shorts動画 [#shorts]',''),item));
 assert.equal(reconcileClassification('本文のみ',item).outcome,'external');
});
test('prepared journal recovers ambiguous PUT/ack failure and subsequent revised decision without duplicate',()=>{
 const applied=reconcileClassification(source,item);
 const prepared={revision:1,receipt:applied.receipt};
 const recovered=reconcileClassification(applied.source,{...item,prepared});assert.equal(recovered.outcome,'applied');assert.equal(recovered.source,applied.source);
 const revised=reconcileClassification(applied.source,{...item,revision:2,choice:'normal',prepared});assert.equal(revised.outcome,'applied');assert.equal(revised.source.split(item.videoId).length-1,1);
});
test('durable decisions use CAS, survive reimport, undo, hold, stale ack and human authority',()=>{
 const imported=importedItem(null,{videoId:item.videoId,line,metadata:item.metadata},'L/動画一覧','L','now');
 const chosen=decide(imported,{revision:0,choice:'shorts'},'editor','now');assert.ok(pending(chosen));
 assert.throws(()=>decide(chosen,{revision:0,choice:'normal'},'other','now'));
 const applied=acknowledge(chosen,{revision:1,outcome:'applied',receipt:{choice:'shorts',line}},'later');
 const reimported=importedItem(applied,{videoId:item.videoId,line,metadata:{}},'L/動画一覧','L','later');assert.equal(reimported.choice,'shorts');
 const undone=decide(applied,{revision:1,undo:true},'editor','later');assert.equal(undone.choice,null);assert.ok(pending(undone));
 assert.throws(()=>acknowledge(undone,{revision:1,outcome:'applied'},'later'));
 const held=decide(applied,{revision:1,choice:'hold'},'editor','later');assert.ok(!pending(held));
 const external=acknowledge(chosen,{revision:1,outcome:'external'},'later');assert.throws(()=>decide(external,{revision:1,choice:'normal'},'editor','later'));
});
export {source,item,line};
