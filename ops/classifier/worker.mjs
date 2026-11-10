import {traceId,tracedResponse} from './trace.mjs';
import {custodyPrepare,custodyCommit,itemKey} from './custody.mjs';
import {ApiError,diagnostic} from './errors.mjs';
import { editorIdentity, syncAuthorized } from './auth.mjs';
import { importedItem, decide, pending, acknowledge } from './model.mjs';
import { HTML } from './ui.mjs';
const headers={ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' };
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
async function body(request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new ApiError(400,'json_required');
  const text=await request.text();if(text.length>1500000)throw new ApiError(400,'payload_too_large');try{return JSON.parse(text);}catch{throw new ApiError(400,'invalid_json');}
}
async function handleRequest(request,env,requestId) {
    const url=new URL(request.url);
    const internal=url.pathname.startsWith('/internal/');
    let actor;
    try {
      if(internal) {if(!await syncAuthorized(request,env))return json({error:'Unauthorized'},401);actor='actions';}
      else actor=await editorIdentity(request,env);
    }catch {
      diagnostic(url.pathname,403,'access_denied',requestId);
      return json({error:'Access denied',code:'access_denied',requestId},403);
    }
    try {
      if(!internal && request.method!=='GET') {
        const requestedWith=request.headers.get('X-Requested-With');
        const editorRequest=requestedWith==='wiki-classifier'||requestedWith==='XMLHttpRequest'&&request.headers.get('X-Classifier-Request')==='wiki-classifier';
        if(request.headers.get('Origin')!==url.origin || !editorRequest){diagnostic(url.pathname,403,'csrf_rejected',requestId);return json({error:'Invalid origin',code:'csrf_rejected'},403);}
      }
      if(url.pathname==='/' && request.method==='GET')return new Response(HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src https://i.ytimg.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
      if(url.pathname==='/app.js' && request.method==='GET') {
        const {JS}=await import('./ui.mjs');return new Response(JS,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      if(url.pathname==='/app.css' && request.method==='GET') {
        const {CSS}=await import('./ui.mjs');return new Response(CSS,{headers:{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }
      const allowed=internal?['POST /internal/import','GET /internal/pending','POST /internal/ack','POST /internal/prepare','GET /internal/item','POST /internal/lookup','POST /internal/custody','GET /internal/custody-recovery','GET /internal/custody-status']:['GET /api/state','GET /api/history','GET /api/item','POST /api/decision'];
      if(!allowed.includes(`${request.method} ${url.pathname}`))return json({error:'Not found'},404);
      const payload=request.method==='GET'?null:await body(request);
      const stub=env.CLASSIFIER.get(env.CLASSIFIER.idFromName('wiki-video-classifier-v1'));
      // Client-supplied headers cannot spoof this actor; the DO binding is private.
      return await stub.fetch(new Request(`https://classifier${url.pathname}${url.search}`,{method:request.method,headers:{'Content-Type':'application/json','X-Actor':actor,'X-Request-Id':requestId},body:payload?JSON.stringify(payload):undefined}));
    }catch(error){const status=error instanceof ApiError?error.status:500;const code=error instanceof ApiError?error.code:'internal_error';diagnostic(url.pathname,status,code,requestId);return json({code,requestId},status);}
}
export default {
  async fetch(request,env){
    const requestId=crypto.randomUUID(),started=performance.now();
    let response;
    try{response=await handleRequest(request,env,requestId);}
    catch{diagnostic(new URL(request.url).pathname,500,'worker_boundary_error',requestId);response=json({code:'internal_error',requestId},500);}
    diagnostic(new URL(request.url).pathname,response.status,'worker_response',requestId,{stage:'worker',elapsedMs:performance.now()-started});
    return tracedResponse(response,requestId);
  },
};

export class Classifier {
  constructor(ctx,env={}) {
    this.env=env;
    this.ctx=ctx;this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, page TEXT NOT NULL, data TEXT NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS items_page ON items(page)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, videoId TEXT NOT NULL, data TEXT NOT NULL)');
  }
  get(id){const rows=this.sql.exec('SELECT data FROM items WHERE id=?',id).toArray();return rows[0]?JSON.parse(rows[0].data):null;}
  put(item){this.sql.exec('INSERT INTO items(id,page,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,page=excluded.page',item.key,item.page,JSON.stringify(item));}
  event(item,action){this.sql.exec('INSERT INTO history(videoId,data) VALUES(?,?)',item.videoId,JSON.stringify({videoId:item.videoId,name:item.name,choice:item.choice,revision:item.revision,actor:item.actor??'actions',at:item.updatedAt,action,outcome:item.outcome,receipt:item.receipt}));}
  async fetch(request) {
    const requestId=traceId(request.headers.get('X-Request-Id')),started=performance.now();
    let response;
    try{response=await this.handle(request,requestId);}
    catch{diagnostic(new URL(request.url).pathname,500,'durable_boundary_error',requestId);response=json({code:'internal_error',requestId},500);}
    diagnostic(new URL(request.url).pathname,response.status,'durable_response',requestId,{stage:'durable_object',elapsedMs:performance.now()-started});
    return tracedResponse(response,requestId);
  }
  async handle(request,requestId) {
    const url=new URL(request.url),actor=request.headers.get('X-Actor'),now=new Date().toISOString();
    try {
      if(url.pathname==='/internal/custody-status'){if(url.searchParams.has('page'))return json({pending:this.sql.exec("SELECT count(*) AS n FROM items WHERE page=? AND json_extract(data,'$.custody.phase')='prepared'",url.searchParams.get('page')).toArray()[0].n});return json(this.sql.exec("SELECT coalesce(sum(CASE WHEN json_extract(data,'$.custody.origin')='wiki' AND json_extract(data,'$.custody.phase')='committed' THEN 1 ELSE 0 END),0) AS wikiTransfersCommitted,coalesce(sum(CASE WHEN json_extract(data,'$.custody.phase')='prepared' THEN 1 ELSE 0 END),0) AS preparedRemaining,coalesce(sum(CASE WHEN json_extract(data,'$.custody.origin')='new' THEN 1 ELSE 0 END),0) AS newDirectCount FROM items").toArray()[0]);}
      if(url.pathname==='/internal/custody-recovery'){return json({items:this.sql.exec("SELECT data FROM items WHERE json_extract(data,'$.custody.phase')='prepared' ORDER BY id LIMIT 5").toArray().map(r=>JSON.parse(r.data))});}
      if(url.pathname==='/internal/item'){const item=this.get(url.searchParams.get('key'));return json({item});}
      if(url.pathname==='/internal/lookup'){
        const {keys}=await request.json();if(!Array.isArray(keys)||keys.length>100||keys.some(k=>typeof k!=='string'))throw new ApiError(400,'invalid_input');
        return json({items:keys.map(key=>this.get(key)).filter(Boolean)});
      }
      if(url.pathname==='/internal/custody'){
        if(this.env.CUSTODY_ENABLED!=='true')throw new ApiError(409,'custody_disabled');
        const data=await request.json();let item;
        this.ctx.storage.transactionSync(()=>{
          if(data.operation==='register'){
            if(typeof data.page!=='string'||data.page.length>300||typeof data.name!=='string')throw new ApiError(400,'invalid_input');
            if(typeof data.row?.line!=='string'||!data.row.line.includes(data.row.videoId)||/[\r\n]/.test(data.row.line)||!Number.isFinite(Date.parse(data.row.metadata?.publishedAt)))throw new ApiError(400,'invalid_input');
            const key=itemKey(data.page,data.row?.videoId);const old=this.get(key);
            if(old){item=old;return;}
            item=importedItem(null,data.row,data.page,data.name,now);
            item={...item,authority:'cloudflare',present:true,wikiPresent:false,originalLines:[item.line],custody:{phase:'committed',origin:'new',line:item.line,committedAt:now}};
          }else if(data.operation==='prepare')item=custodyPrepare(this.get(data.key),data,now);
          else if(data.operation==='failed'){item=this.get(data.key);if(!item?.custody)throw new ApiError(409,'custody_conflict');item={...item,custody:{...item.custody,lastTriedAt:now,error:'conflict_or_failure'}};}
          else if(data.operation==='commit')item=custodyCommit(this.get(data.key),data,now);
          else throw new ApiError(400,'invalid_input');
          this.put(item);
        });return json({item});
      }
      if(url.pathname==='/internal/import') {
        const {pages}=await request.json();if(!Array.isArray(pages)||pages.length>5)throw new ApiError(409,'invalid_sync_input');
        this.ctx.storage.transactionSync(()=>{
          for(const page of pages) {
            if(typeof page.page!=='string'||page.page.length>300||typeof page.name!=='string'||!Array.isArray(page.rows)||page.rows.length>2000)throw new ApiError(409,'invalid_sync_input');
            const ids=new Set();
            for(const row of page.rows) {if(ids.has(row.videoId))throw new ApiError(409,'invalid_sync_input');ids.add(row.videoId);this.put(importedItem(this.get(encodeURIComponent(page.page)+':'+row.videoId),row,page.page,page.name,now));}
            for(const record of this.sql.exec('SELECT data FROM items WHERE page=?',page.page).toArray()) {
              const item=JSON.parse(record.data);
              if(item.authority!=='cloudflare'&&item.present&&!ids.has(item.videoId))this.put({...item,present:false,updatedAt:now});
            }
          }
        });return json({ok:true});
      }
      if(url.pathname==='/internal/pending') {
        // Bounded work per tick; rotation by age includes conflicts without starving fresh decisions.
        const items=this.sql.exec("SELECT data FROM items WHERE (json_extract(data,'$.needsPublication')=1 OR json_extract(data,'$.revision') > json_extract(data,'$.appliedRevision')) AND (coalesce(json_extract(data,'$.choice'),'') != 'hold' OR json_extract(data,'$.authority')='cloudflare') AND (json_extract(data,'$.choice') IS NOT NULL OR json_extract(data,'$.receipt') IS NOT NULL) ORDER BY json_extract(data,'$.lastTriedAt') ASC, id LIMIT 50").toArray().map(r=>JSON.parse(r.data)).filter(pending);
        // Merely reading the queue does not modify state (Dry Run safe).
        return json({items});
      }
      if(url.pathname==='/internal/prepare') {
        const data=await request.json();
        this.ctx.storage.transactionSync(()=>{
          const item=this.get(data.key);
          if(!item||item.revision!==data.revision||!pending(item))throw new ApiError(409,'invalid_sync_input');
          if(!data.receipt||!['shorts','normal','uncategorized','hold'].includes(data.receipt.choice)||typeof data.receipt.line!=='string'||typeof data.receipt.location!=='string')throw new ApiError(409,'invalid_sync_input');
          this.put({...item,prepared:{revision:data.revision,receipt:data.receipt}});
        });return json({ok:true});
      }
      if(url.pathname==='/internal/ack') {
        const {results}=await request.json();if(!Array.isArray(results)||results.length>50)throw new ApiError(409,'invalid_sync_input');
        const conflicts=[];
        this.ctx.storage.transactionSync(()=>{
          for(const result of results) {
            const item=this.get(result.key);
            if(!item||item.revision!==result.revision){conflicts.push(result.videoId);continue;}
            if(item.appliedRevision===result.revision && item.outcome===result.outcome&&!item.needsPublication)continue;
            if(result.outcome==='failed') {this.put({...item,lastTriedAt:now,lastError:'Wiki conflict, missing metadata or API failure'});continue;}
            const next=acknowledge(item,result,now);this.put(next);this.event(next,'wiki');
          }
        });return json({ok:true,conflicts});
      }
      if(url.pathname==='/api/decision') {
        const data=await request.json();if(typeof data?.key!=='string'||typeof data.undo!=='undefined'&&typeof data.undo!=='boolean')throw new ApiError(400,'invalid_input');let next;
        this.ctx.storage.transactionSync(()=>{next=decide(this.get(data.key),data,actor,now);this.put(next);this.event(next,data.undo?'undo':'decision');});
        diagnostic(url.pathname,200,'decision_saved',requestId);
        return json({item:next});
      }
      if(url.pathname==='/api/item') {const item=this.get(url.searchParams.get('key'));if(!item)return json({code:'item_not_found'},404);return json({item});}
      if(url.pathname==='/api/history') {
        const before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER;
        const rows=this.sql.exec('SELECT id,data FROM history WHERE id<? ORDER BY id DESC LIMIT 50',before).toArray();
        return json({events:rows.map(r=>({id:r.id,...JSON.parse(r.data)})),next:rows.at(-1)?.id??null});
      }
      if(url.pathname==='/api/state') {
        const mode=url.searchParams.get('mode')==='classified'?'classified':'queue';
        const offset=Math.max(0,Math.min(100000,Number(url.searchParams.get('offset'))||0));
        const counts=this.sql.exec(`SELECT
          sum(CASE WHEN (json_extract(data,'$.present')=1 OR json_extract(data,'$.authority')='cloudflare') AND json_extract(data,'$.choice') IS NULL AND coalesce(json_extract(data,'$.outcome'),'')!='external' THEN 1 ELSE 0 END) AS unclassified,
          sum(CASE WHEN json_extract(data,'$.choice') IN ('shorts','normal') OR json_extract(data,'$.outcome')='external' THEN 1 ELSE 0 END) AS classified,
          sum(CASE WHEN (json_extract(data,'$.needsPublication')=1 OR json_extract(data,'$.revision')>json_extract(data,'$.appliedRevision')) AND (coalesce(json_extract(data,'$.choice'),'')!='hold' OR json_extract(data,'$.authority')='cloudflare') AND (json_extract(data,'$.choice') IS NOT NULL OR json_extract(data,'$.receipt') IS NOT NULL) THEN 1 ELSE 0 END) AS awaiting,
          sum(CASE WHEN json_extract(data,'$.choice')='hold' THEN 1 ELSE 0 END) AS held FROM items`).toArray()[0];
        const where=mode==='queue'?"(json_extract(data,'$.present')=1 OR json_extract(data,'$.authority')='cloudflare') AND (json_extract(data,'$.choice') IS NULL OR json_extract(data,'$.choice')='hold') AND coalesce(json_extract(data,'$.outcome'),'')!='external'":"json_extract(data,'$.choice') IS NOT NULL OR json_extract(data,'$.receipt') IS NOT NULL OR json_extract(data,'$.outcome')='external'";
        const rank=mode==='queue'?"CASE WHEN json_extract(data,'$.choice')='hold' THEN 1 ELSE 0 END":'0';
        let cursor=null;
        if(url.searchParams.has('cursor')) {
          try {cursor=JSON.parse(atob(url.searchParams.get('cursor')));}catch{throw new ApiError(400,'invalid_cursor');}
          if(!Array.isArray(cursor)||![0,1].includes(cursor[0])||typeof cursor[1]!=='string')throw new ApiError(400,'invalid_cursor');
        }
        const rows=url.searchParams.get('counts')==='1'?[]:this.sql.exec(`SELECT data, id, ${rank} AS rank FROM items WHERE (${where}) ${cursor?`AND (${rank}>? OR (${rank}=? AND id>?))`:''} ORDER BY rank, id LIMIT 50 OFFSET ?`,...(cursor?[cursor[0],cursor[0],cursor[1],0]:[offset])).toArray();
        const items=rows.map(r=>JSON.parse(r.data));
        const tail=rows.at(-1);
        return json({counts,items,next:items.length===50?offset+50:null,nextCursor:items.length===50?btoa(JSON.stringify([tail.rank,tail.id])):null});
      }
      return json({error:'Not found'},404);
    }catch(error){const status=error instanceof ApiError?error.status:error instanceof SyntaxError?400:500;const code=error instanceof ApiError?error.code:error instanceof SyntaxError?'invalid_json':'internal_error';diagnostic(url.pathname,status,code,requestId);return json({code,requestId},status);}
  }
}
