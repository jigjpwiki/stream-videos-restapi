import { insertVideoIntoPage, isVideoAlreadyInPage, formatVideoLine } from '../formatter/wikiTextFormatter.js';

export const UNCATEGORIZED = '***Shorts・投稿動画未分類（自動取得） [#uncategorized]';
export function unclassifiedRows(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(l=>l.trim() === UNCATEGORIZED);
  if (start < 0) return [];
  let end = lines.length;
  for (let i=start+1;i<lines.length;i++) if (/^\*{1,3}(?!\*)/.test(lines[i])) { end=i;break; }
  const rows=[];
  for(let i=start+1;i<end;i++) {
    const match=lines[i].match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})(?![\w-])/);
    if(match && /^-\d{2}\/\d{2}\s/.test(lines[i])) rows.push({videoId:match[1],line:lines[i],index:i});
  }
  return rows;
}
function categoryAt(source, index) {
  let category;
  for(const line of source.split(/\r?\n/).slice(0,index+1)) {
    if(line.trim()===UNCATEGORIZED)category='uncategorized';
    else if(/^\*+Shorts動画 \[#shorts\]/.test(line))category='shorts';
    else if(/^\*+投稿動画 \[#edited_videos\]/.test(line))category='normal';
    else if(/^\*+/.test(line))category=undefined;
  }
  return category;
}
function locationAt(source,index) {
  const stack=[];
  for(const line of source.split(/\r?\n/).slice(0,index)) {
    if(/^\*+/.test(line)) {stack.length=0;stack.push(line.trim());}
    const fold=line.match(/^#fold\(([^,)]+)/);
    if(fold)stack.push(fold[1]);
    if(/^}}}?\s*$/.test(line)&&stack.length>1)stack.pop();
  }
  return stack.join(' / ');
}
export function reconcileClassification(source, item) {
  const {videoId,choice,metadata,receipt,prepared}=item;
  if(!/^[\w-]{11}$/.test(videoId) || !['shorts','normal','uncategorized','hold'].includes(choice))throw Error('Invalid classification');
  const lines=source.split(/\r?\n/);
  const occurrences=lines.map((line,index)=>({line,index})).filter(row=>row.line.includes(videoId));
  const uncat=unclassifiedRows(source).filter(row=>row.videoId===videoId);
  // A duplicate or edited/non-video reference requires human review; do not destroy either row.
  if(occurrences.length>1)throw Error('Duplicate video references');
  if(item.authority==='cloudflare'&&item.custody?.phase!=='committed')throw Error('Custody transfer not committed');
  const hiddenReceipt={choice,line:item.line,location:'cloudflare'};
  if(!occurrences.length){
    if(item.authority!=='cloudflare')return {source,outcome:'external',receipt:null};
    if(['hold','uncategorized'].includes(choice))return {source,outcome:'applied',receipt:hiddenReceipt};
    if(!metadata?.publishedAt||!Number.isFinite(Date.parse(metadata.publishedAt)))throw Error('Verified publication date required');
    const video={...metadata,videoId,videoType:choice,url:`https://www.youtube.com/watch?v=${videoId}`};
    const next=insertVideoIntoPage(source.replaceAll('\r\n','\n'),video);
    if(next===null)throw Error('Destination section missing');
    const nextLines=next.split('\n');const target=nextLines.findIndex(line=>line===formatVideoLine(video));
    if(target<0||typeof item.line!=='string')throw Error('Stored original row required');
    nextLines[target]=item.line;const result=nextLines.join(source.includes('\r\n')?'\r\n':'\n');
    return {source:result,outcome:'applied',receipt:{choice,line:item.line,location:locationAt(result,target)}};
  }
  const current=occurrences[0];
  const currentCategory=categoryAt(source,current.index);
  const location=locationAt(source,current.index);
  const matches=r=>r && r.line===current.line && r.choice===currentCategory && r.location===location;
  const ownsRow=matches(receipt)||matches(prepared?.receipt);
  if(!uncat.length && prepared?.revision===item.revision && matches(prepared.receipt) && currentCategory===choice) return {source,outcome:'applied',receipt:prepared.receipt};
  if(item.authority==='cloudflare'&&!ownsRow)return {source,outcome:'external',receipt:null};
  if(item.authority==='cloudflare'&&['hold','uncategorized'].includes(choice)){const parts=source.match(/[^\n]*\n|[^\n]+$/g)??[];return {source:parts.filter((_,i)=>i!==current.index).join(''),outcome:'applied',receipt:hiddenReceipt};}
  if(!uncat.length && !ownsRow) return {source,outcome:'external',receipt:null};
  if(currentCategory===choice)return {source,outcome:'applied',receipt:{choice,line:current.line,location}};
  if(!metadata?.publishedAt || !Number.isFinite(Date.parse(metadata.publishedAt)))throw Error('Verified publication date required');
  const video={...metadata,videoId,url:`https://www.youtube.com/watch?v=${videoId}`,videoType:choice};
  // Keep the exact existing video row (human title, URL and displayed date).
  const eol=source.includes('\r\n')?'\r\n':'\n';
  const without=lines.filter((_,i)=>i!==current.index).join('\n');
  if(isVideoAlreadyInPage(without,videoId))throw Error('Duplicate video');
  let next=insertVideoIntoPage(without,video);
  if(next===null)throw Error('Destination section missing');
  const generated=formatVideoLine(video);
  const nextLines=next.split('\n');
  const target=nextLines.findIndex(line=>line===generated);
  if(target<0)throw Error('Destination row missing');
  nextLines[target]=current.line;
  next=nextLines.join(eol);
  if(next.split(videoId).length-1!==1)throw Error('Duplicate video after move');
  return {source:next,outcome:'applied',receipt:{choice,line:current.line,location:locationAt(next,target)}};
}
