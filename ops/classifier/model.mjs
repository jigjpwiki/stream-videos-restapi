export function importedItem(old, row, page, name, now) {
  if(!/^[\w-]{11}$/.test(row.videoId) || typeof row.line!=='string' || row.line.length>8000)throw Error('Invalid video row');
  const metadata=row.metadata && typeof row.metadata==='object' ? row.metadata : {};
  const item=old ?? {key:encodeURIComponent(page)+':'+row.videoId,videoId:row.videoId,page,name,choice:null,revision:0,appliedRevision:0,receipt:null,outcome:'new'};
  if(item.page!==page)throw Error('Video belongs to another page');
  return {...item,name,line:row.line,metadata:{...item.metadata,...metadata},present:true,updatedAt:now};
}
export function decide(item, {revision,choice,undo}, actor, now) {
  if(!item || item.revision!==revision)throw Error('Revision conflict');
  if(item.outcome==='external')throw Error('Human Wiki classification is authoritative');
  const next=undo ? item.previousChoice ?? null : choice;
  if(![null,'hold','shorts','normal'].includes(next))throw Error('Invalid choice');
  if(!item.present && !item.receipt)throw Error('Video no longer available');
  return {...item,previousChoice:item.choice,choice:next,revision:item.revision+1,actor,updatedAt:now};
}
export function pending(item) {
  return item.revision>item.appliedRevision && item.choice!=='hold' && (item.choice!==null || item.receipt);
}
export function acknowledge(item, {revision,outcome,receipt}, now) {
  if(!item || item.revision!==revision)throw Error('Revision conflict');
  if(!['applied','external'].includes(outcome))throw Error('Invalid outcome');
  // Repeated receipts are safe; stale receipts never replace a newer decision.
  return {...item,appliedRevision:revision,outcome,receipt:outcome==='applied'?receipt:null,
    present:outcome==='applied'?receipt?.choice==='uncategorized':false,updatedAt:now};
}
