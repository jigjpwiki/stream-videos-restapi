import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('../../ops/state/sync-state.sh',import.meta.url));
test('state branch roundtrip, dry-run immutability, non-main writes and concurrent CAS rejection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'state-test-'));
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const run=(cwd,mode,env={})=>execFileSync('bash',[script,mode],{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
 const live={DRY_RUN:'false',VIDEO_WIKI_WRITE_ENABLED:'true'};
 try {
 const remote=join(root,'remote.git');git(root,'init','--bare',remote);
 const a=join(root,'a');git(root,'clone',remote,a);git(a,'config','user.name','Test');git(a,'config','user.email','test@example.com');
 await mkdir(join(a,'data'));await writeFile(join(a,'data/videos-cache.json'),'{}');await writeFile(join(a,'data/update-state.json'),'{}');
 git(a,'add','.');git(a,'commit','-m','initial');git(a,'branch','-M','main');git(a,'push','origin','main');
 const main=git(a,'rev-parse','HEAD');
 run(a,'load');run(a,'save',{DRY_RUN:'true'});
 assert.equal(git(a,'ls-remote','--heads','origin','automation/wiki-sync-state'),'');
 run(a,'save',live);run(a,'load');
 const b=join(root,'b');git(root,'clone','--branch','main',remote,b);run(b,'load');
 await writeFile(join(a,'data/update-state.json'),'{"version":2}');run(a,'save',live);
 await writeFile(join(b,'data/update-state.json'),'{"version":3}');
 assert.notEqual(spawnSync('bash',[script,'save'],{cwd:b,env:{...process.env,...live}}).status,0);
 run(b,'load');assert.deepEqual(JSON.parse(await readFile(join(b,'data/update-state.json'))),{version:2});
 assert.equal(git(a,'ls-remote','--heads','origin','main').split(/\s/)[0],main.trim());
 }finally{await rm(root,{recursive:true,force:true});}
});
