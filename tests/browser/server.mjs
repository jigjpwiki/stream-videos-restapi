// Local UI test surface only. Production Worker always validates Access.
import {createServer} from 'node:http';
import {HTML,JS,CSS} from '../../ops/classifier/ui.mjs';
if(process.env.CLASSIFIER_UI_TEST!=='1')throw Error('Test server requires explicit local test mode');
createServer((req,res)=>{
 const asset={'/':[HTML,'text/html'],'/app.js':[JS,'text/javascript'],'/app.css':[CSS,'text/css']}[req.url];
 if(!asset){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});res.end(asset[0]);
}).listen(8789,'127.0.0.1');
