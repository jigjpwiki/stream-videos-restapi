import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
// Recovery sources and a reviewable diff must exist before any Wiki write.
export async function savePreview(prefix, before, after) {
  await writeFile(prefix+'.before.wiki', before);
  await writeFile(prefix+'.preview.wiki', after);
  const diff=spawnSync('git',['diff','--no-index','--',prefix+'.before.wiki',prefix+'.preview.wiki'],{encoding:'utf8',maxBuffer:8*1024*1024});
  if(![0,1].includes(diff.status))throw Error('Preview diff failed');
  await writeFile(prefix+'.diff',diff.stdout);
}
