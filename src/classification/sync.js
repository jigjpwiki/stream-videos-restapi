import {hasPublicationDate,mergeMetadata} from '../../ops/classifier/metadata.mjs';
import {validationDetails} from './errors.js';
import {createWikiRateLimit} from '../services/wikiHttp.js';
import {transferToCloudflare,digest} from './custody.js';
import { savePreview } from '../services/preview.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { requestErrorDetails, HttpRequestError } from '../schedule/http.js';
import { videoWikiClient, guardedEdit, WikiPageNotFoundError } from '../services/wikiwiki.js';
import { loadCache, saveCache } from '../services/storage.js';
import { fetchVideoDetails, quotaRequest } from '../services/youtube.js';
import { unclassifiedRows, reconcileClassification } from './wiki.js';

export function classifierClient(env, fetchImpl = fetch) {
  const origin=env.CLASSIFIER_URL;
  const url=new URL(origin);
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||!env.CLASSIFIER_SYNC_TOKEN)throw Error('Expected classifier HTTPS origin and dedicated token');
  return async (path,data) => {
    if(!['/internal/import','/internal/metadata-wait','/internal/pending','/internal/ack','/internal/prepare','/internal/item','/internal/lookup','/internal/custody','/internal/custody-recovery','/internal/custody-status'].includes(path.split('?')[0]))throw Error('Invalid classifier operation');
    const res=await fetchImpl(origin+path,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${env.CLASSIFIER_SYNC_TOKEN}`,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw Error('Classifier request failed');return res.json();
  };
}
export async function runClassifications({env=process.env,livers,cache,state,wiki,remote,now=new Date(),output='work/classifications',
  rateLimit=createWikiRateLimit(),details=fetchVideoDetails,persistCache=saveCache,persist=async value=>{await writeFile('data/classification-state.json.tmp',JSON.stringify(value,null,2)+'\n');await rename('data/classification-state.json.tmp','data/classification-state.json');},
}={}) {
  if(env.CLASSIFIER_SYNC_ENABLED!=='true')return {skipped:true};
  const dryRun=env.DRY_RUN!=='false'||env.VIDEO_WIKI_WRITE_ENABLED!=='true';
  livers??=JSON.parse(await readFile(new URL('../config/livers.json',import.meta.url)));
  cache=structuredClone(cache??await loadCache());
  if(!state) {try {state=JSON.parse(await readFile('data/classification-state.json'));}catch(e){if(e.code!=='ENOENT')throw e;state={};}}
  state=structuredClone(state);
  if(Date.parse(state.wikiRetryAt)>+now)rateLimit.restore(state.wikiRetryAt);
  wiki??=videoWikiClient(env,fetch,{rateLimit});remote??=classifierClient(env);
  await mkdir(output,{recursive:true});
  const report={dryRun,scanned:[],results:[],scanSkipped:[],scanFailures:[],scanDeferred:[],metadataFailures:[],metadataUnavailable:[],unclassifiedCount:0,written:false};
  const pendingResponse=await remote('/internal/pending');
  if(!Array.isArray(pendingResponse.items)||pendingResponse.items.length>50)throw Error('Invalid classifier queue');
  const queue=pendingResponse.items;
  report.metadataWaitingScheduled=pendingResponse.metadataWaiting??0;
  if(!Number.isInteger(report.metadataWaitingScheduled)||report.metadataWaitingScheduled<0)throw Error('Invalid metadata waiting count');
  const waitingObserved=new Map();

  const custodyEnabled=env.CLASSIFIER_CUSTODY_ENABLED==='true';
  const custodyBatch=Number(env.CLASSIFIER_CUSTODY_BATCH_SIZE??10);
  if(!Number.isInteger(custodyBatch)||custodyBatch<1||custodyBatch>50)throw Error('Invalid custody batch size');
  const scanSize=dryRun&&env.CLASSIFIER_SCAN_ALL==='true'?livers.length:Math.min(5,livers.length);
  let rateFailures=0, pauseUntil=Date.parse(rateLimit.snapshot().retryAt)||0, scanAttempted=0;
  function rateLimited(error) {
    if(!(error instanceof HttpRequestError)||error.status!==429)return false;
    rateFailures++;
    if(error.code==='rate_limited'||rateFailures>=2||(error.retryAfterMs??0)>5000)
      {rateLimit.postpone(error);pauseUntil=Date.parse(rateLimit.snapshot().retryAt);}
    return true;
  }
  const deferredEntry=(item,error)=>({...item,outcome:'deferred',reason:'rate_limited',...(error?requestErrorDetails(error):{}),...(pauseUntil?{retryAt:new Date(pauseUntil).toISOString()}: {})});
  const sources=new Map();
  const pages=[];const start=(state.scanIndex??0)%Math.max(1,livers.length);
  // Scan even disabled livers: historical Wiki rows must remain discoverable.
  for(let i=0;i<scanSize;i++) {
    const liver=livers[(start+i)%livers.length];
    if(pauseUntil){report.scanDeferred.push(deferredEntry({page:liver.wikiPageName}));continue;}
    scanAttempted++;
    try {
      const source=await wiki.get(liver.wikiPageName);rateFailures=0;sources.set(liver.wikiPageName,source);
      pages.push({page:liver.wikiPageName,name:liver.name,rows:[...new Map(unclassifiedRows(source).map(row=>[row.videoId,row])).values()].map(row=>({videoId:row.videoId,line:row.line,metadata:cache[liver.youtubeChannelId]?.find(v=>v.videoId===row.videoId)}))});
      report.scanned.push(liver.wikiPageName);
    }catch (error) {
      const entry={page:liver.wikiPageName,...requestErrorDetails(error)};
      if(rateLimited(error)) {
        report.scanDeferred.push(deferredEntry({page:liver.wikiPageName},error));
      } else if(error instanceof WikiPageNotFoundError) {
        report.scanSkipped.push(entry);
        console.warn(JSON.stringify({phase:'classification_scan',level:'warning',...entry}));
      } else {
        report.scanFailures.push(entry);
        console.error(JSON.stringify({phase:'classification_scan',level:'error',...entry}));
      }
    }
  }
  if(pendingResponse.metadataWaitSupported===true){
    const keys=[...new Set(pages.flatMap(p=>p.rows.map(row=>encodeURIComponent(p.page)+':'+row.videoId)))];
    for(let i=0;i<keys.length;i+=100){
      const response=await remote('/internal/lookup',{keys:keys.slice(i,i+100)});
      if(!Array.isArray(response.items))throw Error('Invalid metadata lookup');
      for(const item of response.items)waitingObserved.set(item.key,item);
    }
  }
  report.unclassifiedCount=pages.reduce((count,page)=>count+page.rows.length,0);
  const metadata=new Map();
  for(const video of Object.values(cache).flat())metadata.set(video.videoId,mergeMetadata(metadata.get(video.videoId),video));
  for(const item of waitingObserved.values())metadata.set(item.videoId,mergeMetadata(metadata.get(item.videoId),item.metadata));
  for(const item of queue)metadata.set(item.videoId,mergeMetadata(metadata.get(item.videoId),item.metadata));
  const postponedIds=new Set([...waitingObserved.values()].filter(item=>item.metadataRetry?.revision===item.revision&&Date.parse(item.metadataRetry.nextCheckAt)>+now&&!hasPublicationDate(metadata.get(item.videoId))).map(item=>item.videoId));
  const missing=[...new Set([...queue,...pages.flatMap(p=>p.rows)].map(v=>v.videoId))].filter(id=>!hasPublicationDate(metadata.get(id))||!Number.isFinite(metadata.get(id)?.durationSeconds)).filter(id=>!postponedIds.has(id)).slice(0,50);
  const {request,usage}=quotaRequest(3);
  if(missing.length) {
    try {
      const fetched=await details(missing,env.YOUTUBE_API_KEY,request);
      if(!Array.isArray(fetched)||fetched.some(v=>!missing.includes(v?.videoId)||!hasPublicationDate(v)))throw Error('Invalid metadata response');
      for(const video of fetched)metadata.set(video.videoId,mergeMetadata(metadata.get(video.videoId),video));
      report.metadataUnavailable=missing.filter(id=>!fetched.some(v=>v.videoId===id));
      // Queue items may be outside this tick's five scanned pages. Retain verified
      // details in the existing durable cache without inventing a page snapshot.
      if(!dryRun&&fetched.length){
        for(const video of fetched){
          const owners=new Set([...queue.filter(i=>i.videoId===video.videoId).map(i=>i.page),...pages.filter(p=>p.rows.some(r=>r.videoId===video.videoId)).map(p=>p.page)]);
          for(const liver of livers.filter(l=>owners.has(l.wikiPageName))){
            const entries=cache[liver.youtubeChannelId]??=[];const index=entries.findIndex(v=>v.videoId===video.videoId);
            const merged=mergeMetadata(index<0?null:entries[index],video);
            if(index<0)entries.push(merged);else entries[index]=merged;
          }
        }
        try{await persistCache(cache);}catch{report.metadataCacheFailed=true;}
      }
    }catch(error){report.metadataFailures.push(...missing);report.metadataError=requestErrorDetails(error);}
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
        const remove=new Set(rows.filter(row=>hasPublicationDate(metadata.get(row.videoId))).map(row=>row.index));const parts=source.match(/[^\n]*\n|[^\n]+$/g)??[];
        const after=parts.filter((_,index)=>!remove.has(index)).join('');
        const prefix=join(output,digest(page.page)+'.custody-plan');await savePreview(prefix,source,after);
        const planned=remove.size;
        report.custody.planned+=planned;
        for(const row of page.rows.filter(row=>!hasPublicationDate(metadata.get(row.videoId))))report.custody.results.push({page:page.page,videoId:row.videoId,outcome:'metadata_waiting',reason:'missing_publication_date'});
        report.custody.results.push({page:page.page,planned,beforeHash:digest(source),afterHash:digest(after),previewPrefix:prefix});
      }catch{report.custody.failed++;report.custody.results.push({page:page.page,outcome:'dry_run_conflict'});}}
    }
    const transfers=pages.flatMap(page=>page.rows.map(row=>({page:page.page,row})));
    // Prepared transfers remain discoverable even after Wiki PUT succeeds and its response is lost.
    if(!dryRun){
      let recovery={items:[]};try{recovery=await remote('/internal/custody-recovery');}catch{report.recoveryFailed=true;}
      for(const item of recovery.items??[])if(!transfers.some(t=>t.page===item.page&&t.row.videoId===item.videoId))transfers.unshift({page:item.page,row:{videoId:item.videoId,line:item.line}});
    }
    for(const transfer of (report.importFailed||report.metadataCacheFailed||dryRun?[]:transfers.slice(0,custodyBatch))){if(pauseUntil){report.custody.results.push(deferredEntry({page:transfer.page,videoId:transfer.row.videoId}));continue;}if(blockedPages.has(transfer.page))continue;
      if(!hasPublicationDate(metadata.get(transfer.row.videoId))){
        const failed=report.metadataFailures.includes(transfer.row.videoId);
        if(failed)report.custody.failed++;
        report.custody.results.push({page:transfer.page,videoId:transfer.row.videoId,outcome:failed?'failed':'metadata_waiting',reason:failed?'metadata_fetch_failed':'missing_publication_date'});continue;
      }
      try{
      if(!livers.some(l=>l.wikiPageName===transfer.page))throw Error('Unknown custody page');
      const result=await transferToCloudflare({wiki,remote,...transfer,dryRun,output,onPrepared:()=>checkpointManaged(transfer)});
      report.custody.results.push(result);
      if(result.withdrawn){report.custody.withdrawn++;await checkpointManaged(transfer);}
    }catch(error){if(rateLimited(error)){report.custody.results.push(deferredEntry({page:transfer.page,videoId:transfer.row.videoId},error));continue;}blockedPages.add(transfer.page);if(!dryRun){try{await remote('/internal/custody',{operation:'failed',key:encodeURIComponent(transfer.page)+':'+transfer.row.videoId});}catch{}}report.custody.failed++;report.custody.results.push({page:transfer.page,videoId:transfer.row.videoId,outcome:'conflict_or_failure'});}}
  }
  const receipts=[];
  for(let item of queue) {
    if(report.metadataCacheFailed){report.results.push({key:item.key,videoId:item.videoId,revision:item.revision,outcome:'failed',reason:'metadata_cache_failed'});continue;}
    if(pauseUntil){report.results.push(deferredEntry({key:item.key,videoId:item.videoId,revision:item.revision}));continue;}
    if(blockedPages.has(item.page)){report.results.push({videoId:item.videoId,outcome:'custody_page_paused'});continue;}
    if(item.authority==='cloudflare'&&!custodyEnabled){report.results.push({videoId:item.videoId,outcome:'custody_paused'});continue;}
    const liver=livers.find(l=>l.wikiPageName===item.page);
    if(!liver || !/^[\w-]{11}$/.test(item.videoId) || item.key!==encodeURIComponent(item.page)+':'+item.videoId) {report.results.push({videoId:item.videoId,outcome:'failed'});continue;}
    try {
      if(custodyEnabled&&!dryRun)item=(await remote('/internal/item?key='+encodeURIComponent(item.key))).item??item;
      let resolution;
      const result=await guardedEdit({wiki,page:item.page,dryRun,writeEnabled:!dryRun,
        transform(source) {resolution=reconcileClassification(source,{...item,metadata:mergeMetadata(item.metadata,metadata.get(item.videoId)),choice:item.choice??'uncategorized'});return resolution.source;},
        async save(before,after){const prefix=join(output,`${item.authority==='cloudflare'?digest(item.page).slice(0,12)+'.':''}${item.videoId}-r${item.revision}`);await savePreview(prefix,before,after);
          if(!dryRun && before!==after)await remote('/internal/prepare',{key:item.key,videoId:item.videoId,revision:item.revision,receipt:resolution.receipt});},
      });
      const receipt={key:item.key,videoId:item.videoId,revision:item.revision,outcome:resolution.outcome,receipt:resolution.receipt};
      report.results.push({...receipt,...result});receipts.push(receipt);rateFailures=0;
    }catch (error) {if(rateLimited(error)){report.results.push(deferredEntry({key:item.key,videoId:item.videoId,revision:item.revision},error));continue;}const validation=validationDetails(error);
      if(validation?.reason==='missing_publication_date'&&!report.metadataFailures.includes(item.videoId)){
        report.results.push({key:item.key,videoId:item.videoId,revision:item.revision,outcome:'metadata_waiting',...validation,availability:report.metadataUnavailable.includes(item.videoId)?'not_returned':'unknown'});continue;
      }
      const failed={key:item.key,videoId:item.videoId,revision:item.revision,outcome:'failed',...(validation??requestErrorDetails(error)),...(validation?.reason==='missing_publication_date'&&report.metadataFailures.includes(item.videoId)?{reason:'metadata_fetch_failed'}:{})};receipts.push(failed);report.results.push(failed);}
  }
  if(!dryRun) {
    const waiting=report.results.filter(r=>r.outcome==='metadata_waiting').map(({key,revision})=>({key,revision}));
    if(waiting.length){
      if(pendingResponse.metadataWaitSupported===true){
        try{const result=await remote('/internal/metadata-wait',{items:waiting});report.metadataWaitConflicts=result.conflicts??[];}catch{report.metadataWaitUpdateFailed=true;}
      }else report.metadataWaitUnsupported=true;
    }
    if(receipts.length){try{const ack=await remote('/internal/ack',{results:receipts});report.ackConflicts=ack.conflicts??[];}catch{report.ackFailed=true;}}
    state.scanIndex=(start+scanAttempted)%Math.max(1,livers.length);
    if(pauseUntil)state.wikiRetryAt=new Date(pauseUntil).toISOString();else delete state.wikiRetryAt;
    if(report.importFailed||report.ackFailed)state.scanIndex=start;
    if(pauseUntil||(!report.importFailed&&!report.ackFailed))await persist(state);
  }
  if(custodyEnabled&&!dryRun){try{report.custody.totals=await remote('/internal/custody-status');}catch{report.statusFailed=true;}}
  report.failed=!!(report.importFailed||report.recoveryFailed||report.ackFailed||report.statusFailed||report.metadataCacheFailed||report.metadataWaitUpdateFailed||report.metadataWaitConflicts?.length)||report.custody.failed>0||report.results.some(r=>r.outcome==='failed')||report.scanFailures.length>0||report.metadataFailures.length>0||!!report.ackConflicts?.length;
  report.written=report.results.some(r=>r.written===true)||report.custody.results.some(r=>r.written===true);
  report.writeUnverified=[...report.results,...report.custody.results].some(r=>r.writeUnverified);
  report.writeAttempted=report.written||[...report.results,...report.custody.results].some(r=>r.writeAttempted);
  report.metadataWaiting=report.results.filter(r=>r.outcome==='metadata_waiting').length;
  report.deferred=report.metadataWaitingScheduled+report.metadataWaiting+report.scanDeferred.length+report.results.filter(r=>r.outcome==='deferred'||r.outcome.endsWith('_paused')).length+report.custody.results.filter(r=>['deferred','metadata_waiting'].includes(r.outcome)).length;
  report.complete=!report.failed&&report.deferred===0;
  report.outcome=report.failed?'failure':report.deferred?'deferred':report.scanSkipped.length?'success_with_warnings':'success';
  console.log(JSON.stringify({phase:'classifications',dryRun,outcome:report.outcome,deferred:report.deferred,complete:report.complete,scanned:report.scanned.length,skipped:report.scanSkipped.length,scanFailures:report.scanFailures.length,applyFailures:report.results.filter(r=>r.outcome==='failed').length,metadataFailures:report.metadataFailures.length,metadataWaiting:report.metadataWaiting,metadataWaitingScheduled:report.metadataWaitingScheduled,metadataWaitUnsupported:report.metadataWaitUnsupported===true,metadataUnavailable:report.metadataUnavailable.length,unclassifiedCount:report.unclassifiedCount,custodyPlanned:report.custody.planned,custodyWithdrawn:report.custody.withdrawn,custodyFailed:report.custody.failed,written:report.written,writeAttempted:report.writeAttempted,writeUnverified:report.writeUnverified}));
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(output,'import-preview.json'),JSON.stringify({pages},null,2)+'\n');
  return report;
}
