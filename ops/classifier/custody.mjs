import {ApiError} from './errors.mjs';
export const itemKey=(page,id)=>encodeURIComponent(page)+':'+id;
export function custodyPrepare(item,data,now){
 if(!item||item.revision!==data.revision)throw new ApiError(409,'revision_conflict');
 if(item.custody?.phase==='committed')return item;
 if(item.line!==data.line||!data.line?.includes(item.videoId)||!['beforeHash','afterHash'].every(k=>/^[a-f0-9]{64}$/.test(data[k]??'')))throw new ApiError(409,'custody_conflict');
 if(item.custody && (item.custody.beforeHash!==data.beforeHash||item.custody.afterHash!==data.afterHash||item.custody.line!==data.line))throw new ApiError(409,'custody_conflict');
 return {...item,authority:'cloudflare',custody:{phase:'prepared',origin:'wiki',line:data.line,beforeHash:data.beforeHash,afterHash:data.afterHash,preparedAt:item.custody?.preparedAt??now},originalLines:[...new Set([...(item.originalLines??[]),item.line])],updatedAt:now};
}
export function custodyCommit(item,data,now){
 if(!item?.custody||item.custody.origin!=='wiki'||!/^[a-f0-9]{64}$/.test(data.afterHash??'')||item.custody.afterHash!==data.afterHash)throw new ApiError(409,'custody_conflict');
 return {...item,authority:'cloudflare',present:true,wikiPresent:false,needsPublication:item.custody.phase==='committed'?item.needsPublication:['shorts','normal'].includes(item.choice),custody:{...item.custody,phase:'committed',committedAt:item.custody.committedAt??now},updatedAt:now};
}
