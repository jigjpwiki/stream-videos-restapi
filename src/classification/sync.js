import {transferToCloudflare,digest} from './custody.js';
import { savePreview } from '../services/preview.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { requestErrorDetails } from '../schedule/http.js';
import { videoWikiClient, guardedEdit, WikiPageNotFoundError } from '../services/wikiwiki.js';
import { loadCache, saveCache } from '../services/storage.js';
import { fetchVideoDetails, quotaRequest } from '../services/youtube.js';
import { unclassifiedRows, reconcileClassification } from './wiki.js';

export function classifierClient(env, fetchImpl = fetch) {
  const origin=env.CLASSIFIER_URL;
  const url=new URL(origin);
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||!env.CLASSIFIER_SYNC_TOKEN)throw Error('Expected classifier HTTPS origin and dedicated token');
  return async (path,data) => {
    if(!['/internal/import','/internal/pending','/internal/ack','/internal/prepare','/internal/item','/internal/lookup','/internal/custody','/internal/custody-recovery','/internal/custody-status'].includes(path.split('?')[0]))throw Error('Invalid classifier operation');
    const res=await fetchImpl(origin+path,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${env.CLASSIFIER_SYNC_TOKEN}`,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw Error('Classifier request failed');return res.json();
  };
}
export async function runClassifications({env=process.env,livers,cache,state,wiki,remote,now=new Date(),output='work/classifications',
  details=fetchVideoDetails,persistCache=saveCache,persist=async value=>{await writeFile('data/classification-state.json.tmp',JSON.stringify(value,null,2)+'\n');await rename('data/classification-state.json.tmp','data/classification-state.json');},
}={}) {
  if(env.CLASSIFIER_SYNC_ENABLED!=='true')return {skipped:true};
  const dryRun=env.DRY_RUN!=='false'||env.VIDEO_WIKI_WRITE_ENABLED!=='true';
  livers??=JSON.parse(await readFile(new URL('../config/livers.json',import.meta.url)));
  cache=structuredClone(cache??await loadCache());
  if(!state) {try {state=JSON.parse(await readFile('data/classification-state.json'));}catch(e){if(e.code!=='ENOENT')throw e;state={};}}
  state=structuredClone(state);wiki??=videoWikiClient(env);remote??=classifierClient(env);
  await mkdir(output,{recursive:true});
  const report={dryRun,scanned:[],results:[],scanSkipped:[],scanFailures:[],metadataFailures:[],unclassifiedCount:0,written:false};
  const pendingResponse=await remote('/internal/pending');
  if(!Array.isArray(pendingResponse.items)||pendingResponse.items.length>50)throw Error('Invalid classifier queue');
  const queue=pendingResponse.items;
  const custodyEnabled=env.CLASSIFIER_CUSTODY_ENABLED==='true';
  const custodyBatch=Number(env.CLASSIFIER_CUSTODY_BATCH_SIZE??10);
  if(!Number.isInteger(custodyBatch)||custodyBatch<1||custodyBatch>50)throw Error('Invalid custody batch size');
  const scanSize=dryRun&&env.CLASSIFIER_SCAN_ALL==='true'?livers.length:Math.min(5,livers.length);
  const sources=new Map();
  const pages=[];const start=(state.scanIndex??0)%Math.max(1,livers.length);
  // Scan even disabled livers: historical Wiki rows must remain discoverable.
  for(let i=0;i<scanSize;i++) {
    const liver=livers[(start+i)%livers.length];
    try {
      const source=await wiki.get(liver.wikiPageName);sources.set(liver.wikiPageName,source);
      pages.push({page:liver.wikiPageName,name:liver.name,rows:[...new Map(unclassifiedRows(source).map(row=>[row.videoId,row])).values()].map(row=>({videoId:row.videoId,line:row.line,metadata:cache[liver.youtubeChannelId]?.find(v=>v.videoId===row.videoId)}))});
      report.scanned.push(liver.wikiPageName);
    }catch (error) {
      const entry={page:liver.wikiPageName,...requestErrorDetails(error)};
      if(error instanceof WikiPageNotFoundError) {
        report.scanSkipped.push(entry);
        console.warn(JSON.stringify({phase:'classification_scan',level:'warning',...entry}));
      } else {
        report.scanFailures.push(entry);
        console.error(JSON.stringify({phase:'classification_scan',level:'error',...entry}));
      }
    }
  }
  report.unclassifiedCount=pages.reduce((count,page)=>count+page.rows.length,0);
  const metadata=new Map(Object.values(cache).flat().map(v=>[v.videoId,v]));
  for(const item of queue)if(item.metadata?.publishedAt)metadata.set(item.videoId,item.metadata);
  const missing=[...new Set([...queue,...pages.flatMap(p=>p.rows)].map(v=>v.videoId))].filter(id=>!metadata.get(id)?.publishedAt||!Number.isFinite(metadata.get(id)?.durationSeconds)).slice(0,50);
  const {request,usage}=quotaRequest(3);
  if(missing.length) {
    try {for(const video of await details(missing,env.YOUTUBE_API_KEY,request))metadata.set(video.videoId,video);}
    catch {report.metadataFailures.push(...missing);}
  }
  report.quota=usage;
  for(const page of pages)for(const row of page.rows)row.metadata=metadata.get(row.videoId)??null;
  // Dry Run never modifies Cloudflare queue, receipts, cursor, cache or Wiki.
  if(!dryRun && pages.length){try{await remote('/internal/import',{pages});}catch{report.importFailed=true;}}
  report.custody={enabled:custodyEnabled,planned:0,withdrawn:0,failed:0,results:[]};
  const blockedPages=new Set();
  if(custodyEnabled){
    async function checkpointManaged(transfer){
      const liver=livers.find(l=>l.wikiPageName===transfer.page);const entries=cache[liver.youtubeChannelId]??=[];
      const entry=entries.find(v=>v.videoId===transfer.row.videoId);
      if(entry)entry._cloudflareManaged=true;else entries.push({...transfer.row.metadata,videoId:transfer.row.videoId,_cloudflareManaged:true});
      await persistCache(cache);
    }
    if(dryRun){
      // One combined before/preview per page avoids O(rows * page-size) dry-run artifacts.
      for(const page of pages){try{
        const source=sources.get(page.page);const rows=unclassifiedRows(source);
        if(page.rows.some(row=>source.split(row.videoId).length!==2))throw Error('Duplicate custody rows');
        const remove=new Set(rows.map(row=>row.index));const parts=source.match(/[^\n]*\n|[^\n]+$/g)??[];
        const after=parts.filter((_,index)=>!remove.has(index)).join('');
        const prefix=join(output,digest(page.page)+'.custody-plan');await savePreview(prefix,source,after);
        report.custody.planned+=page.rows.length;
        report.custody.results.push({page:page.page,planned:page.rows.length,beforeHash:digest(source),afterHash:digest(after),previewPrefix:prefix});
      }catch{report.custody.failed++;report.custody.results.push({page:page.page,outcome:'dry_run_conflict'});}}
    }
    const transfers=pages.flatMap(page=>page.rows.map(row=>({page:page.page,row})));
    // Prepared transfers remain discoverable even after Wiki PUT succeeds and its response is lost.
    if(!dryRun){
      let recovery={items:[]};try{recovery=await remote('/internal/custody-recovery');}catch{report.recoveryFailed=true;}
      for(const item of recovery.items??[])if(!transfers.some(t=>t.page===item.page&&t.row.videoId===item.videoId))transfers.unshift({page:item.page,row:{videoId:item.videoId,line:item.line}});
    }
    for(const transfer of (report.importFailed||dryRun?[]:transfers.slice(0,custodyBatch))){if(blockedPages.has(transfer.page))continue;try{
      if(!livers.some(l=>l.wikiPageName===transfer.page))throw Error('Unknown custody page');
      const result=await transferToCloudflare({wiki,remote,...transfer,dryRun,output,onPrepared:()=>checkpointManaged(transfer)});
      report.custody.results.push(result);
      if(result.withdrawn){report.custody.withdrawn++;await checkpointManaged(transfer);}
    }catch{blockedPages.add(transfer.page);if(!dryRun){try{await remote('/internal/custody',{operation:'failed',key:encodeURIComponent(transfer.page)+':'+transfer.row.videoId});}catch{}}report.custody.failed++;report.custody.results.push({page:transfer.page,videoId:transfer.row.videoId,outcome:'conflict_or_failure'});}}
  }
  const receipts=[];
  for(let item of queue) {
    if(blockedPages.has(item.page)){report.results.push({videoId:item.videoId,outcome:'custody_page_paused'});continue;}
    if(item.authority==='cloudflare'&&!custodyEnabled){report.results.push({videoId:item.videoId,outcome:'custody_paused'});continue;}
    const liver=livers.find(l=>l.wikiPageName===item.page);
    if(!liver || !/^[\w-]{11}$/.test(item.videoId) || item.key!==encodeURIComponent(item.page)+':'+item.videoId) {report.results.push({videoId:item.videoId,outcome:'failed'});continue;}
    try {
      if(custodyEnabled&&!dryRun)item=(await remote('/internal/item?key='+encodeURIComponent(item.key))).item??item;
      let resolution;
      const result=await guardedEdit({wiki,page:item.page,dryRun,writeEnabled:!dryRun,
        transform(source) {resolution=reconcileClassification(source,{...item,metadata:metadata.get(item.videoId)??item.metadata,choice:item.choice??'uncategorized'});return resolution.source;},
        async save(before,after){const prefix=join(output,`${item.authority==='cloudflare'?digest(item.page).slice(0,12)+'.':''}${item.videoId}-r${item.revision}`);await savePreview(prefix,before,after);
          if(!dryRun && before!==after)await remote('/internal/prepare',{key:item.key,videoId:item.videoId,revision:item.revision,receipt:resolution.receipt});},
      });
      const receipt={key:item.key,videoId:item.videoId,revision:item.revision,outcome:resolution.outcome,receipt:resolution.receipt};
      report.results.push({...receipt,...result});receipts.push(receipt);
    }catch (error) {const failed={key:item.key,videoId:item.videoId,revision:item.revision,outcome:'failed',...requestErrorDetails(error)};receipts.push(failed);report.results.push(failed);}
  }
  if(!dryRun) {
    if(receipts.length){try{const ack=await remote('/internal/ack',{results:receipts});report.ackConflicts=ack.conflicts??[];}catch{report.ackFailed=true;}}
    state.scanIndex=(start+Math.min(5,livers.length))%Math.max(1,livers.length);
    if(!report.importFailed&&!report.ackFailed)await persist(state);
  }
  if(custodyEnabled&&!dryRun){try{report.custody.totals=await remote('/internal/custody-status');}catch{report.statusFailed=true;}}
  report.failed=!!(report.importFailed||report.recoveryFailed||report.ackFailed||report.statusFailed)||report.custody.failed>0||report.results.some(r=>r.outcome==='failed')||report.scanFailures.length>0||report.metadataFailures.length>0||!!report.ackConflicts?.length;
  report.written=report.results.some(r=>r.written===true)||report.custody.results.some(r=>r.written===true);
  report.outcome=report.failed?'failure':report.scanSkipped.length?'success_with_warnings':'success';
  console.log(JSON.stringify({phase:'classifications',dryRun,outcome:report.outcome,scanned:report.scanned.length,skipped:report.scanSkipped.length,scanFailures:report.scanFailures.length,applyFailures:report.results.filter(r=>r.outcome==='failed').length,metadataFailures:report.metadataFailures.length,unclassifiedCount:report.unclassifiedCount,custodyPlanned:report.custody.planned,custodyWithdrawn:report.custody.withdrawn,custodyFailed:report.custody.failed,written:report.written}));
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(output,'import-preview.json'),JSON.stringify({pages},null,2)+'\n');
  return report;
}
