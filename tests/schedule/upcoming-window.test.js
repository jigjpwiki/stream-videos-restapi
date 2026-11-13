import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classify} from '../../src/schedule/normalize.js';
import {run} from '../../src/schedule/index.js';
import {replaceSections} from '../../src/schedule/formatWiki.js';
const now=new Date('2026-11-14T23:45:00+09:00');
const row=(date,id='abcdefghijk',platform='youtube')=>({date,id,identity:id,name:id,platform,status:'upcoming',url:platform==='youtube'?`https://youtu.be/${id}`:`https://www.twitch.tv/${id}`});
for(const platform of ['youtube','twitch']){
 test(`${platform}: next-day 00:30/08:00/12-hour endpoint included, elapsed and later starts excluded`,()=>{
  const records=[row('2026-11-15T12:00:00+09:00','late',platform),row('2026-11-15T11:45:00+09:00','boundary',platform),row('2026-11-14T23:30:00+09:00','past',platform),row('2026-11-15T08:00:00+09:00','morning',platform),row('2026-11-15T00:30:00+09:00','midnight',platform)];
  assert.deepEqual(classify(records,now).upcoming.map(r=>r.id),['midnight','morning','boundary']);
 });
 test(`${platform}: precise inclusive boundaries and equivalent UTC timestamps`,()=>{
  const offsets=[-1,0,12*3600000,12*3600000+1];
  const records=offsets.map((offset,i)=>row(new Date(+now+offset).toISOString(),String(i),platform));
  assert.deepEqual(classify(records,now).upcoming.map(r=>r.id),['1','2']);
  assert.deepEqual(classify(records,new Date('2026-11-14T14:45:00Z')),classify(records,now));
 });
}
for(const [current,next]of [['2026-11-30T23:45:00+09:00','2026-12-01T00:30:00+09:00'],['2026-12-31T23:45:00+09:00','2027-01-01T00:30:00+09:00'],['2028-02-29T23:45:00+09:00','2028-03-01T00:30:00+09:00']]){
 test(`absolute time crosses ${current.slice(0,10)} without calendar filtering`,()=>assert.equal(classify([row(next)],new Date(current)).upcoming.length,1));
}
test('filter then sort and take ten; sparse/empty windows never borrow later streams',()=>{
 const valid=Array.from({length:12},(_,i)=>row(new Date(+now+(i+1)*3600000).toISOString(),'v'+i));
 const outside=[row(new Date(+now-1).toISOString(),'past'),row(new Date(+now+13*3600000).toISOString(),'later')];
 assert.deepEqual(classify([...outside,...valid.toReversed()],now).upcoming.map(r=>r.id),valid.slice(0,10).map(r=>r.id));
 assert.equal(classify([valid[0],outside[1]],now).upcoming.length,1);
 assert.deepEqual(classify(outside,now),{live:[],upcoming:[]});
});
test('same-time order stays menu order then platform/id under input reordering',()=>{
 const time='2026-11-15T00:30:00+09:00';const records=[row(time,'b'),row(time,'a'),row(time,'a','twitch'),row(time,'priority')];
 const config={'youtube:priority':{menuOrder:0}};
 const ids=items=>items.map(r=>r.platform+':'+r.id);
 const expected=['youtube:priority','twitch:a','youtube:a','youtube:b'];
 assert.deepEqual(ids(classify(records,now,config).upcoming),expected);assert.deepEqual(ids(classify(records.toReversed(),now,config).upcoming),expected);
});
test('each injected tick moves the window; live output and past live streams remain unchanged',()=>{
 const records=[row('2026-11-15T00:30:00+09:00','first'),row('2026-11-15T11:45:00+09:00','boundary'),row('2026-11-15T12:00:00+09:00','enter'),{...row('2026-11-13T10:00:00+09:00','live','twitch'),status:'live'}];
 const first=classify(records,now),second=classify(records,new Date('2026-11-15T00:31:00+09:00'));
 assert.deepEqual(first.upcoming.map(r=>r.id),['first','boundary']);assert.deepEqual(second.upcoming.map(r=>r.id),['boundary','enter']);assert.deepEqual(first.live,second.live);
});
for(const sourceDate of ['2026-11-14T22:00:00+09:00','2026-11-15T00:30:00+09:00'])test(`real acquisition path (${sourceDate}) fetches full dated input and verifies next-day/rescheduled YouTube start before window filtering; dry run preserves Wiki format`,async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixture.json',import.meta.url))),output=await mkdtemp(join(tmpdir(),'schedule-window-'));
 const reservation={...fixture.youtube[1],date:sourceDate};let puts=0,verifiedIds=[];
 try{
  const report=await run({now,output,env:{YOUTUBE_API_KEY:'test',WIKI_API_BASE_URL:'https://api.wikiwiki.jp/jigjp',WIKI_PASSWORD:'test',DRY_RUN:'true'},fetchImpl:async(url,options)=>{
   const u=new URL(url);if(options.method==='PUT'){puts++;assert.fail('Dry Run PUT');}
   if(u.hostname==='www.jigdule.jp'){assert.equal(u.search,'');return Response.json(u.pathname.endsWith('/youtube.json')?[reservation]:[]);}
   if(u.hostname==='www.googleapis.com'){verifiedIds=u.searchParams.get('id').split(',');return Response.json({items:[{id:'lmnopqrstuv',snippet:{channelId:reservation.youtubeid,liveBroadcastContent:'upcoming'},liveStreamingDetails:{scheduledStartTime:'2026-11-15T00:30:00+09:00'},contentDetails:{duration:'P0D'}}]});}
   if(u.pathname.endsWith('/auth'))return Response.json({token:'test'});
   assert.equal(u.hostname,'api.wikiwiki.jp');return Response.json({source:fixture.source});
  }});
  assert.deepEqual(verifiedIds,['lmnopqrstuv']);assert.equal(report.upcoming,1);assert.equal(report.written,false);assert.equal(puts,0);
  const preview=await readFile(join(output,'preview.wiki'),'utf8');assert.ok(preview.includes('00時30分～'));assert.ok(!preview.includes('[開始待ち]'));
  const content=classify([row('2026-11-15T00:30:00+09:00','lmnopqrstuv')],now);assert.ok(replaceSections(fixture.source,content).includes('00時30分～'));
 }finally{await rm(output,{recursive:true,force:true});}
});

test('same-day reservations beyond twelve hours are excluded as well',()=>{
 const current=new Date('2026-11-14T09:00:00+09:00');
 assert.deepEqual(classify([row('2026-11-14T23:00:00+09:00','too_far'),row('2026-11-14T21:00:00+09:00','within')],current).upcoming.map(r=>r.id),['within']);
});
