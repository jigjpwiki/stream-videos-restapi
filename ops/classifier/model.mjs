import {mergeMetadata} from './metadata.mjs';
import {ApiError} from './errors.mjs';
export function importedItem(old, row, page, name, now) {
  if(!/^[\w-]{11}$/.test(row.videoId) || typeof row.line!=='string' || row.line.length>8000)throw new ApiError(409,'invalid_sync_input');
  const metadata=row.metadata && typeof row.metadata==='object' ? row.metadata : {};
  const item=old ?? {key:encodeURIComponent(page)+':'+row.videoId,videoId:row.videoId,page,name,choice:null,revision:0,appliedRevision:0,receipt:null,outcome:'new'};
  if(item.page!==page)throw new ApiError(409,'invalid_sync_input');
  if(item.authority==='cloudflare')return {...item,metadata:mergeMetadata(item.metadata,metadata),observedWikiLines:[...new Set([...(item.observedWikiLines??[]),row.line])],updatedAt:now};
  return {...item,name,line:row.line,originalLines:[...new Set([...(item.originalLines??[]),...(item.line?[item.line]:[]),row.line])],metadata:mergeMetadata(item.metadata,metadata),present:true,updatedAt:now};
}
export function decide(item, {revision,choice,undo}, actor, now) {
  if(!Number.isInteger(revision)||revision<0)throw new ApiError(400,'invalid_revision');
  if(!item || item.revision!==revision)throw new ApiError(409,'revision_conflict');
  if(item.outcome==='external')throw new ApiError(409,'wiki_authoritative');
  const next=undo ? item.previousChoice ?? null : choice;
  if(![null,'hold','shorts','normal'].includes(next))throw new ApiError(400,'invalid_choice');
  if(!item.present && !item.receipt && item.authority!=='cloudflare')throw new ApiError(409,'item_unavailable');
  return {...item,previousChoice:item.choice,choice:next,revision:item.revision+1,actor,updatedAt:now};
}
export function pending(item) {
  return item.needsPublication || item.revision>item.appliedRevision && (item.choice!=='hold'||item.authority==='cloudflare') && (item.choice!==null || item.receipt);
}
export function acknowledge(item, {revision,outcome,receipt}, now) {
  if(!item || item.revision!==revision)throw Error('Revision conflict');
  if(!['applied','external'].includes(outcome))throw Error('Invalid outcome');
  // Repeated receipts are safe; stale receipts never replace a newer decision.
  return {...item,needsPublication:false,appliedRevision:revision,outcome,receipt:outcome==='applied'?receipt:null,
    present:item.authority==='cloudflare'?true:outcome==='applied'?receipt?.choice==='uncategorized':false,updatedAt:now};
}
