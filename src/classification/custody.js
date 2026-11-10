import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {guardedEdit} from '../services/wikiwiki.js';
import {savePreview} from '../services/preview.js';
import {unclassifiedRows} from './wiki.js';
export const digest=source=>createHash('sha256').update(source).digest('hex');
export async function transferToCloudflare({wiki,remote,page,row,dryRun=true,output,onPrepared=async()=>{}}){
 const key=encodeURIComponent(page)+':'+row.videoId;
 let stored=dryRun?null:(await remote('/internal/item?key='+encodeURIComponent(key))).item;
 if(stored?.outcome==='external')throw Error('Human classification requires review');
 if(!dryRun&&(!stored||stored.line!==row.line))throw Error('Custody source not persisted');
 let beforeHash,afterHash,missing=false;
 const edit=await guardedEdit({wiki,page,dryRun,writeEnabled:!dryRun,
  transform(source){
   beforeHash=digest(source);
   if(stored?.custody?.phase==='committed'){
    // Never remove a human re-add after a committed transfer.
    if(source.includes(row.videoId))throw Error('Human re-added managed video');
    missing=true;afterHash=stored.custody.afterHash;return source;
   }
   const rows=unclassifiedRows(source).filter(r=>r.videoId===row.videoId);
   if(!rows.length){
    // Recover an ambiguous PUT only with the exact prepared after-image hash.
    if(stored?.custody?.phase==='prepared'&&stored.custody.afterHash===beforeHash){missing=true;afterHash=beforeHash;return source;}
    throw Error('Custody source changed or missing');
   }
   if(rows.length!==1||rows[0].line!==row.line||source.split(row.videoId).length!==2)throw Error('Custody row conflict');
   const parts=source.match(/[^\n]*\n|[^\n]+$/g)??[];
   const after=parts.filter((_,index)=>index!==rows[0].index).join('');
   afterHash=digest(after);
   if(stored?.custody&&(stored.custody.beforeHash!==beforeHash||stored.custody.afterHash!==afterHash))throw Error('Custody page changed after prepare');
   return after;
  },
  async save(before,after){
   await savePreview(join(output,`${row.videoId}.custody.${digest(before)}`),before,after);
   if(dryRun||missing)return;
   const prepared=await remote('/internal/custody',{operation:'prepare',key,revision:stored.revision,line:row.line,beforeHash,afterHash});
   const verified=(await remote('/internal/item?key='+encodeURIComponent(key))).item;
   if(!verified||verified.key!==key||verified.line!==row.line||verified.custody?.phase!=='prepared'||verified.custody.beforeHash!==beforeHash||verified.custody.afterHash!==afterHash||verified.revision!==prepared.item.revision||Object.entries(row.metadata??{}).some(([key,value])=>JSON.stringify(verified.metadata?.[key])!==JSON.stringify(value)))throw Error('Custody verification failed');
   await onPrepared();
  },
 });
 if(!dryRun){
  const result=await remote('/internal/custody',{operation:'commit',key,afterHash});
  const verified=(await remote('/internal/item?key='+encodeURIComponent(key))).item;
  if(result.item?.custody?.phase!=='committed'||verified?.custody?.phase!=='committed'||verified.line!==row.line)throw Error('Custody commit verification failed');
 }
 return {key,videoId:row.videoId,planned:dryRun,withdrawn:!dryRun&&(edit.written||missing),written:edit.written,beforeHash,afterHash};
}
