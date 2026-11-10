import { editorIdentity, syncAuthorized } from './auth.mjs';
import { importedItem, decide, pending, acknowledge } from './model.mjs';
import { HTML } from './ui.mjs';
const headers={ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' };
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
async function body(request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw Error('JSON required');
  const text=await request.text();if(text.length>1500000)throw Error('Payload too large');return JSON.parse(text);
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    const internal=url.pathname.startsWith('/internal/');
    let actor;
    try {
      if(internal) {if(!await syncAuthorized(request,env))return json({error:'Unauthorized'},401);actor='actions';}
      else actor=await editorIdentity(request,env);
    }catch {return json({error:'Access denied'},403);}
    try {
      if(!internal && request.method!=='GET') {
        if(request.headers.get('Origin')!==url.origin || request.headers.get('X-Requested-With')!=='wiki-classifier')return json({error:'Invalid origin'},403);
      }
      if(url.pathname==='/' && request.method==='GET')return new Response(HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src https://i.ytimg.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
      if(url.pathname==='/app.js' && request.method==='GET') {
        const {JS}=await import('./ui.mjs');return new Response(JS,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      if(url.pathname==='/app.css' && request.method==='GET') {
        const {CSS}=await import('./ui.mjs');return new Response(CSS,{headers:{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      const allowed=internal?['POST /internal/import','GET /internal/pending','POST /internal/ack','POST /internal/prepare']:['GET /api/state','GET /api/history','POST /api/decision'];
      if(!allowed.includes(`${request.method} ${url.pathname}`))return json({error:'Not found'},404);
      const payload=request.method==='GET'?null:await body(request);
      const stub=env.CLASSIFIER.get(env.CLASSIFIER.idFromName('wiki-video-classifier-v1'));
      // Client-supplied headers cannot spoof this actor; the DO binding is private.
      return await stub.fetch(new Request(`https://classifier${url.pathname}${url.search}`,{method:request.method,headers:{'Content-Type':'application/json','X-Actor':actor},body:payload?JSON.stringify(payload):undefined}));
    }catch{return json({error:'Operation failed; retry after reloading'},409);}
  },
};

export class Classifier {
  constructor(ctx) {
    this.ctx=ctx;this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, page TEXT NOT NULL, data TEXT NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS items_page ON items(page)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, videoId TEXT NOT NULL, data TEXT NOT NULL)');
  }
  get(id){const rows=this.sql.exec('SELECT data FROM items WHERE id=?',id).toArray();return rows[0]?JSON.parse(rows[0].data):null;}
  put(item){this.sql.exec('INSERT INTO items(id,page,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,page=excluded.page',item.key,item.page,JSON.stringify(item));}
  event(item,action){this.sql.exec('INSERT INTO history(videoId,data) VALUES(?,?)',item.videoId,JSON.stringify({videoId:item.videoId,name:item.name,choice:item.choice,revision:item.revision,actor:item.actor??'actions',at:item.updatedAt,action,outcome:item.outcome}));}
  async fetch(request) {
    const url=new URL(request.url),actor=request.headers.get('X-Actor'),now=new Date().toISOString();
    try {
      if(url.pathname==='/internal/import') {
        const {pages}=await request.json();if(!Array.isArray(pages)||pages.length>5)throw Error();
        this.ctx.storage.transactionSync(()=>{
          for(const page of pages) {
            if(typeof page.page!=='string'||page.page.length>300||typeof page.name!=='string'||!Array.isArray(page.rows)||page.rows.length>2000)throw Error();
            const ids=new Set();
            for(const row of page.rows) {if(ids.has(row.videoId))throw Error();ids.add(row.videoId);this.put(importedItem(this.get(encodeURIComponent(page.page)+':'+row.videoId),row,page.page,page.name,now));}
            for(const record of this.sql.exec('SELECT data FROM items WHERE page=?',page.page).toArray()) {
              const item=JSON.parse(record.data);
              if(item.present&&!ids.has(item.videoId))this.put({...item,present:false,updatedAt:now});
            }
          }
        });return json({ok:true});
      }
      if(url.pathname==='/internal/pending') {
        // Bounded work per tick; rotation by age includes conflicts without starving fresh decisions.
        const items=this.sql.exec("SELECT data FROM items WHERE json_extract(data,'$.revision') > json_extract(data,'$.appliedRevision') AND coalesce(json_extract(data,'$.choice'),'') != 'hold' AND (json_extract(data,'$.choice') IS NOT NULL OR json_extract(data,'$.receipt') IS NOT NULL) ORDER BY json_extract(data,'$.lastTriedAt') ASC, id LIMIT 50").toArray().map(r=>JSON.parse(r.data)).filter(pending);
        // Merely reading the queue does not modify state (Dry Run safe).
        return json({items});
      }
      if(url.pathname==='/internal/prepare') {
        const data=await request.json();
        this.ctx.storage.transactionSync(()=>{
          const item=this.get(data.key);
          if(!item||item.revision!==data.revision||!pending(item))throw Error();
          if(!data.receipt||!['shorts','normal','uncategorized'].includes(data.receipt.choice)||typeof data.receipt.line!=='string'||typeof data.receipt.location!=='string')throw Error();
          this.put({...item,prepared:{revision:data.revision,receipt:data.receipt}});
        });return json({ok:true});
      }
      if(url.pathname==='/internal/ack') {
        const {results}=await request.json();if(!Array.isArray(results)||results.length>50)throw Error();
        const conflicts=[];
        this.ctx.storage.transactionSync(()=>{
          for(const result of results) {
            const item=this.get(result.key);
            if(!item||item.revision!==result.revision){conflicts.push(result.videoId);continue;}
            if(item.appliedRevision===result.revision && item.outcome===result.outcome)continue;
            if(result.outcome==='failed') {this.put({...item,lastTriedAt:now,lastError:'Wiki conflict, missing metadata or API failure'});continue;}
            const next=acknowledge(item,result,now);this.put(next);this.event(next,'wiki');
          }
        });return json({ok:true,conflicts});
      }
      if(url.pathname==='/api/decision') {
        const data=await request.json();let next;
        this.ctx.storage.transactionSync(()=>{next=decide(this.get(data.key),data,actor,now);this.put(next);this.event(next,data.undo?'undo':'decision');});
        return json({item:next});
      }
      if(url.pathname==='/api/history') {
        const before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER;
        const rows=this.sql.exec('SELECT id,data FROM history WHERE id<? ORDER BY id DESC LIMIT 50',before).toArray();
        return json({events:rows.map(r=>({id:r.id,...JSON.parse(r.data)})),next:rows.at(-1)?.id??null});
      }
      if(url.pathname==='/api/state') {
        const mode=url.searchParams.get('mode')==='classified'?'classified':'queue';
        const offset=Math.max(0,Math.min(100000,Number(url.searchParams.get('offset'))||0));
        const counts=this.sql.exec(`SELECT
          sum(CASE WHEN json_extract(data,'$.present')=1 AND json_extract(data,'$.choice') IS NULL THEN 1 ELSE 0 END) AS unclassified,
          sum(CASE WHEN json_extract(data,'$.choice') IN ('shorts','normal') THEN 1 ELSE 0 END) AS classified,
          sum(CASE WHEN json_extract(data,'$.revision')>json_extract(data,'$.appliedRevision') AND coalesce(json_extract(data,'$.choice'),'')!='hold' AND (json_extract(data,'$.choice') IS NOT NULL OR json_extract(data,'$.receipt') IS NOT NULL) THEN 1 ELSE 0 END) AS awaiting,
          sum(CASE WHEN json_extract(data,'$.choice')='hold' THEN 1 ELSE 0 END) AS held FROM items`).toArray()[0];
        const where=mode==='queue'?"json_extract(data,'$.present')=1 AND (json_extract(data,'$.choice') IS NULL OR json_extract(data,'$.choice')='hold')":"json_extract(data,'$.choice') IS NOT NULL OR json_extract(data,'$.receipt') IS NOT NULL OR json_extract(data,'$.outcome')='external'";
        const items=this.sql.exec(`SELECT data FROM items WHERE ${where} ORDER BY CASE WHEN json_extract(data,'$.choice')='hold' THEN 1 ELSE 0 END, id LIMIT 50 OFFSET ?`,offset).toArray().map(r=>JSON.parse(r.data));
        return json({counts,items,next:items.length===50?offset+50:null});
      }
      return json({error:'Not found'},404);
    }catch{return json({error:'Revision conflict or invalid input; reload'},409);}
  }
}
