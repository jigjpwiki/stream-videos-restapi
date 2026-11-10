// Local-only test surface: real model/SQLite DO API; never used by production Worker.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {HTML,JS,CSS} from '../../ops/classifier/ui.mjs';
import {Classifier} from '../../ops/classifier/worker.mjs';
if(process.env.CLASSIFIER_UI_TEST!=='1')throw Error('Explicit local test mode required');
let db,worker;
function reset(items=[]){db?.close();db=new DatabaseSync(':memory:');worker=new Classifier({storage:{sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}});for(const item of items)worker.put(item);}
reset();
createServer(async(req,res)=>{
 try{
 const asset={'/':[HTML,'text/html'],'/app.js':[JS,'text/javascript'],'/app.css':[CSS,'text/css']}[req.url];
 if(asset){res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});res.end(asset[0]);return;}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const text=Buffer.concat(chunks).toString();
 if(req.url==='/__reset'&&req.method==='POST'){reset(JSON.parse(text).items);res.end('{}');return;}
 if(!req.url.startsWith('/api/')){res.writeHead(404);res.end();return;}
 const response=await worker.fetch(new Request('https://local'+req.url,{method:req.method,headers:{'Content-Type':'application/json','X-Actor':'test@example.com'},body:req.method==='POST'?text:undefined}));
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
 }catch{res.writeHead(500);res.end('{}');}
}).listen(8789,'127.0.0.1');
