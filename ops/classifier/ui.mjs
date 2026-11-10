export const CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src https://i.ytimg.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
export const HTML=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>動画の分類</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><main><header><p class="eyebrow">JIGJP WIKI / EDITOR</p><h1>動画の分類</h1><p>Shortsと投稿動画を、ひとつずつ整理。</p></header><section id="counts" aria-label="分類件数"></section><nav><button id="queue">未分類・保留</button><button id="classified">分類済み・修正</button><button id="history">履歴</button><button id="refresh">更新</button></nav><p id="message" role="status" aria-live="polite"></p><p id="recovery" hidden><a id="reauth" href="/" target="_blank" rel="noopener noreferrer">認証をやり直す（別タブ）</a>。認証後、この画面の「更新」を押してください。</p><article id="card" tabindex="0"><img id="thumbnail" alt="動画のサムネイル" draggable="false"><div class="info"><p id="name"></p><h2 id="title"></h2><p id="meta"></p><p id="status"></p><a id="link" target="_blank" rel="noopener noreferrer">YouTubeで確認 ↗</a></div><p id="gesture">ここで左右・下にスワイプして分類</p></article><section id="actions" aria-label="分類操作"><button id="shorts">← Shorts</button><button id="hold">↓ 保留</button><button id="normal">投稿動画 →</button></section><p class="hint">左右・下にスワイプ / 矢印キーでも操作できます。</p><div class="toolbar"><button id="undo" disabled>直前の分類を取り消す</button><button id="next">次のカード</button></div><section id="historyList" hidden><h2>変更履歴</h2><ol></ol><button id="moreHistory">前の履歴</button></section><footer>分類は保存後、次回以降の同期でWikiへ反映します。Wikiでの手動分類を優先します。</footer></main></body></html>`;
export const CSS=`:root{font-family:system-ui,sans-serif;color:#1c2937;background:#eef2f4}*{box-sizing:border-box}body{margin:0}main{max-width:800px;margin:auto;padding:30px 20px 50px}header{margin:10px 0 24px}.eyebrow{font-size:12px;letter-spacing:.15em;color:#546875;font-weight:700}h1{font-size:32px;margin:8px 0}header>p:last-child{color:#526270}#counts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px}#counts div{background:white;border-radius:12px;padding:14px 8px;text-align:center;font-size:12px;color:#526270}#counts strong{display:block;font-size:24px;color:#1c2937}nav,.toolbar{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;font-size:14px;padding:12px 16px;background:white;border:1px solid #b8c5cb;border-radius:10px;cursor:pointer;color:#253a47;min-height:46px}button:disabled{opacity:.45;cursor:wait}button:focus-visible,a:focus-visible{outline:3px solid #008075;outline-offset:3px}#message{min-height:24px;color:#8c3c1e}article{overflow:hidden;border-radius:18px;background:white;box-shadow:0 12px 30px #143c4f12;touch-action:pan-y} #gesture{touch-action:none;font-size:12px;color:#657681;padding:12px 20px;margin:0}article img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#d5dfe4}.info{padding:18px 22px 24px}#name{color:#00786b;font-weight:700;margin:0 0 8px}h2{font-size:21px;line-height:1.5;margin:0 0 10px}#meta,#status{font-size:14px;color:#526270}a{color:#00786b;text-underline-offset:3px}#actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:16px}#shorts{background:#e5f3f1;border-color:#73aaa2}#normal{background:#e7effa;border-color:#8da9d1}.hint,footer{font-size:12px;color:#657681;line-height:1.8}.hint{text-align:center;margin:14px 0 20px}.toolbar{justify-content:space-between}footer{margin-top:30px}#historyList{background:white;padding:20px;margin-top:24px;border-radius:12px}li{margin:12px 0;line-height:1.6;font-size:14px}li button{margin-left:8px;padding:5px 10px;min-height:36px}@media(max-width:480px){main{padding:18px 12px 35px}h1{font-size:27px}#counts div{padding:10px 4px;font-size:11px}#counts strong{font-size:22px}button{padding:10px;font-size:13px}.info{padding:16px}h2{font-size:18px}}`;
export const JS=String.raw`
const el=id=>document.getElementById(id);
// Report only the directive, never blockedURI/originalPolicy (which can contain URLs).
document.addEventListener('securitypolicyviolation',event=>{if(event.effectiveDirective==='connect-src')console.warn(JSON.stringify({component:'classifier-ui',operation:'api_transport',code:'csp_connect_blocked'}));});
let items=[],index=0,mode='queue',cursor=null,busy=false,last=null,historyBefore=null,counts={},version=0,authRequired=false,pendingDecision=null,countsController=null;
let visited=new Set(),deferred=[],deferredPass=false,lastCardKey=null;
const label={shorts:'Shorts',normal:'投稿動画',hold:'保留',uncategorized:'未分類'};
const errors={400:'操作内容が不正です。更新して再操作してください。',401:'認証が切れました。再ログインしてください。',403:'編集権限または認証を確認してください。',409:'他の編集が入りました。最新データを確認して再操作してください。',500:'サーバーで処理できませんでした。少し待って再操作してください。'};
const workerAuth={
 jwt_missing:['reauthenticate','認証JWTが届いていません。認証を確認してください。'],
 jwt_expired:['reauthenticate','認証JWTの有効期限が切れました。再認証してください。'],
 jwt_malformed:['contact_admin','認証JWTの形式を検証できません。管理者へ原因コードを連絡してください。'],
 jwt_algorithm_invalid:['contact_admin','認証方式が一致しません。管理者による確認が必要です。'],
 jwt_signature_invalid:['contact_admin','JWT署名を検証できません。管理者による確認が必要です。'],
 jwt_issuer_mismatch:['contact_admin','認証issuerが一致しません。管理者による確認が必要です。'],
 jwt_audience_mismatch:['contact_admin','認証audienceが一致しません。管理者による確認が必要です。'],
 jwt_time_invalid:['contact_admin','JWTの時刻情報が不正です。管理者による確認が必要です。'],
 jwt_issued_in_future:['contact_admin','JWTの発行時刻を検証できません。管理者による確認が必要です。'],
 jwt_not_yet_valid:['contact_admin','JWTはまだ有効ではありません。管理者による時刻確認が必要です。'],
 jwt_identity_missing:['contact_admin','JWTの編集者情報を検証できません。管理者による確認が必要です。'],
 jwt_unknown_key:['contact_admin','対応する署名公開鍵がありません。管理者による確認が必要です。'],
 editor_not_allowed:['contact_admin','この編集者には操作権限がありません。管理者へ確認してください。'],
 auth_configuration:['contact_admin','認証設定が不正です。管理者による確認が必要です。'],
 editor_configuration:['contact_admin','編集者許可リストの設定を確認してください。'],
 auth_keys_timeout:['retry','認証公開鍵の取得がタイムアウトしました。再ログインせず時間を置いて更新してください。'],
 auth_keys_network:['retry','認証公開鍵への接続に失敗しました。再ログインせず時間を置いて更新してください。'],
 auth_keys_http:['retry','認証公開鍵サービスが一時的に利用できません。時間を置いて更新してください。'],
 auth_keys_redirect:['retry','認証公開鍵の取得先が転送を返しました。管理者へ確認してください。'],
 auth_keys_invalid:['retry','認証公開鍵の応答を検証できません。時間を置いて更新してください。'],
 auth_check_unavailable:['retry','認証サービスを確認できません。時間を置いて更新してください。'],
};
const responseMessages={
 redirect_response:'APIが別の画面へ転送されました。認証を確認して「更新」を押してください。',
 unexpected_html:'APIからJSONではなくHTMLが返されました。認証またはアクセス制限を確認してください。',
 non_json_response:'APIがJSON以外の応答を返しました。「更新」で再確認してください。',
 invalid_json:'APIのJSON応答を読み取れませんでした。「更新」で再確認してください。',
 invalid_payload:'API応答の形式を確認できませんでした。「更新」で再確認してください。',
 timeout:'通信がタイムアウトしました。「更新」で確認してください。',
 fetch_failed:'通信を確認できませんでした。ネットワーク・CORS・接続制限を確認し「更新」を押してください。',
};
function failure(code,details={}){
 const status=details.status||0;
 const e=Error(details.authSource==='worker'&&workerAuth[details.serverCode]?workerAuth[details.serverCode][1]:code==='http_error'?(errors[status]||(status===429?'アクセスが制限されています。時間を置いて「更新」してください。':status>=500?errors[500]:'取得できませんでした。「更新」で確認してください。')):responseMessages[code]||'応答を確認できませんでした。');
 Object.assign(e,details,{code,status});
 e.authRelated=details.authSource==='worker'?details.authAction==='reauthenticate':code==='redirect_response'||code==='unexpected_html'||status===401;
 if(code!=='cancelled')console.warn(JSON.stringify({component:'classifier-ui',operation:details.operation,status,code,contentType:details.contentType??'unavailable',redirected:!!details.redirected,responseType:details.responseType??'unavailable',requestId:details.requestId,cfRay:details.cfRay,serverCode:details.serverCode,authSource:details.authSource,authAction:details.authAction}));
 return e;
}
function validItem(item){return item&&typeof item.key==='string'&&typeof item.videoId==='string'&&/^[\w-]{11}$/.test(item.videoId)&&Number.isInteger(item.revision)&&item.revision>=0&&(item.line==null||typeof item.line==='string')&&(item.metadata==null||typeof item.metadata==='object'&&!Array.isArray(item.metadata));}
function validPayload(path,data){
 const route=path.split('?')[0];
 if(route==='/api/state')return data&&Array.isArray(data.items)&&data.items.every(validItem)&&data.counts&&typeof data.counts==='object'&&['unclassified','classified','awaiting','held'].every(k=>data.counts[k]===null||Number.isFinite(data.counts[k]))&&(data.nextCursor==null||typeof data.nextCursor==='string'&&data.nextCursor.length<8000);
 if(route==='/api/item'||route==='/api/decision')return validItem(data?.item);
 if(route==='/api/history')return Array.isArray(data?.events)&&data.events.every(event=>event&&typeof event==='object');
 return false;
}
async function api(path,data,{signal}={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let details={operation:path.split('?')[0]};
 try{
  let r;
  try{r=await fetch(path,{method:data?'POST':'GET',headers:{Accept:'application/json','X-Requested-With':'XMLHttpRequest',...(data?{'Content-Type':'application/json','X-Classifier-Request':'wiki-classifier'}:{})},body:data?JSON.stringify(data):undefined,credentials:'same-origin',mode:'same-origin',redirect:'manual',cache:'no-store',signal:controller.signal});}
  catch{throw failure(signal?.aborted?'cancelled':controller.signal.aborted?'timeout':'fetch_failed',details);}
  const mime=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  const contentType=/^application\/(?:json|[a-z0-9.+-]+\+json)$/.test(mime)?'json':mime==='text/html'?'html':mime==='text/plain'?'text':mime?'other':'missing';
  const requestId=r.headers.get('x-request-id'),ray=r.headers.get('cf-ray');
  details={...details,status:r.status,contentType,redirected:r.redirected||r.type==='opaqueredirect'||r.status>=300&&r.status<400,responseType:['basic','cors','opaque','opaqueredirect','default'].includes(r.type)?r.type:'other',requestId:/^[a-f0-9-]{36}$/i.test(requestId||'')?requestId:undefined,cfRay:/^[a-f0-9]{16}(?:-[a-z0-9]+)?$/i.test(ray||'')?ray:undefined};
  if(details.redirected)throw failure('redirect_response',details);
  if(!r.ok){
   let data; if(contentType==='json'){try{data=await r.json();}catch{}}
   const verifiedWorker=r.headers.get('x-classifier-auth-source')==='worker'&&data?.authSource==='worker'&&Object.hasOwn(workerAuth,data?.code);
   details={...details,authSource:verifiedWorker?'worker':!details.requestId&&(r.status===401||r.status===403)?'access_or_edge':'unknown',...(verifiedWorker?{serverCode:data.code,authAction:workerAuth[data.code][0]}:{})};
   throw failure('http_error',details);
  }
  if(contentType!=='json')throw failure(contentType==='html'?'unexpected_html':'non_json_response',details);
  let value;
  try{value=await r.json();}catch{throw failure(signal?.aborted?'cancelled':controller.signal.aborted?'timeout':'invalid_json',details);}
  if(!validPayload(path,value))throw failure('invalid_payload',details);
  return value;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
function showError(error,prefix=''){
 if(error.authRelated){authRequired=true;el('recovery').hidden=false;el('recovery').scrollIntoView({block:'nearest'});}
 const context=(error.status?' (HTTP '+error.status+')':'')+(error.serverCode?' / '+error.serverCode:'');
 message(prefix+error.message+context+(error.requestId?' / requestId: '+error.requestId:error.cfRay?' / cf-ray: '+error.cfRay:''));
 render();
}
function begin(){countsController?.abort();return ++version;}
function message(text){el('message').textContent=text;}
function lock(value){busy=value;for(const id of ['next','refresh','queue','classified','history','moreHistory'])el(id).disabled=value;el('undo').disabled=value||authRequired||!!pendingDecision||!last;render();}
function render(){
 el('undo').disabled=busy||authRequired||!!pendingDecision||!last;
 const item=items[index];el('card').hidden=!item;el('actions').hidden=!item;el('next').hidden=!item&&!cursor;
 for(const id of ['shorts','normal','hold'])el(id).disabled=busy||authRequired||!!pendingDecision||!item||item.outcome==='external';
 if(!item)return;
 el('thumbnail').src='https://i.ytimg.com/vi/'+item.videoId+'/mqdefault.jpg';el('name').textContent=item.name;
 el('title').textContent=item.metadata?.title||item.line?.match(/\[\[(.*?):https?:/)?.[1]||item.videoId;
 const date=item.metadata?.publishedAt?new Date(item.metadata.publishedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'公開日を確認中';
 const seconds=item.metadata?.durationSeconds;el('meta').textContent=date+' / '+(Number.isFinite(seconds)?Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'時間を確認中');
 el('status').textContent=(label[item.choice]||'未分類')+' · '+(item.outcome==='external'?'Wikiの手動分類を優先':item.custody?.phase==='prepared'?'移管確認待ち':(item.needsPublication||item.revision>item.appliedRevision)&&(item.choice!=='hold'||item.authority==='cloudflare')&&(item.choice!==null||item.receipt)?'Wiki反映待ち':'保存済み')+(item.lastError?' / 反映時にエラー。次の同期で再確認します。':'');
 el('link').href='https://www.youtube.com/watch?v='+item.videoId;
}
function showCounts(data){counts=data;const names={unclassified:'未分類',classified:'分類済み',awaiting:'Wiki反映待ち',held:'保留'};el('counts').replaceChildren();for(const [key,name]of Object.entries(names)){const div=document.createElement('div'),strong=document.createElement('strong');strong.textContent=counts[key]||0;div.append(strong,document.createTextNode(name));el('counts').append(div);}}
async function load(reset=false){const data=await api('/api/state?mode='+mode+(reset?'':cursor?'&cursor='+encodeURIComponent(cursor):''));
 if(reset){visited=new Set();deferred=[];deferredPass=false;lastCardKey=null;}
 if(!reset&&cursor&&data.nextCursor===cursor)throw failure('invalid_payload',{operation:'/api/state'});
 items=data.items.filter(item=>!visited.has(item.key));index=0;cursor=data.nextCursor??null;showCounts(data.counts);render();}
async function advance(){
 while(index>=items.length&&cursor)await load();
 if(index>=items.length){
  if(!deferredPass&&deferred.length&&(deferred.length>1||deferred[0].key!==lastCardKey)){items=deferred;deferred=[];index=0;deferredPass=true;}
  else {items=[];index=0;message('この巡回は完了しました。保留は「更新」で再確認できます。');}
 }
 render();
}
async function refreshCounts(stamp){
 countsController=new AbortController();
 try{const data=await api('/api/state?counts=1',undefined,{signal:countsController.signal});if(version===stamp)showCounts(data.counts);}
 catch(error){if(version===stamp&&error.code!=='cancelled')showError(error,'分類は保存済みです。件数の再取得に失敗しました。');}
}
function acceptSaved(updated,operation){
 const {item,choice,undo}=operation;
 last=undo?null:updated;
 if(undo){visited.delete(updated.key);deferred=deferred.filter(v=>v.key!==updated.key);items=items.filter(v=>v.key!==updated.key);index=Math.min(index,items.length);items.splice(index,0,updated);}
 else if(mode==='queue'){visited.add(item.key);lastCardKey=item.key;const at=items.findIndex(v=>v.key===item.key);if(at>=0)items.splice(at,1);if(choice==='hold'&&!deferredPass)deferred.push(updated);}
 else {const at=items.findIndex(v=>v.key===item.key);if(at>=0)items[at]=updated;}
}
async function conflict(item,fresh){
 fresh??=(await api('/api/item?key='+encodeURIComponent(item.key))).item;
 if(fresh.key!==item.key)throw failure('invalid_payload',{operation:'/api/item'});
 if(last?.key===fresh.key&&last.revision!==fresh.revision)last=null;
 const at=items.findIndex(v=>v.key===fresh.key);
 if(mode==='queue'&&(['shorts','normal'].includes(fresh.choice)||fresh.outcome==='external')){visited.add(fresh.key);if(at>=0)items.splice(at,1);await advance();}
 else if(at>=0)items[at]=fresh;else items.splice(index,0,fresh);
 render();message(errors[409]);
}
async function reconcilePending(){
 const operation=pendingDecision;if(!operation)return 'none';
 const fresh=(await api('/api/item?key='+encodeURIComponent(operation.item.key))).item;
 if(fresh.key!==operation.item.key||fresh.revision<operation.item.revision)throw failure('invalid_payload',{operation:'/api/item'});
 const expected=operation.undo?operation.item.previousChoice??null:operation.choice;
 pendingDecision=null;
 console.info(JSON.stringify({component:'classifier-ui',operation:'save_verification',outcome:fresh.revision===operation.item.revision?'not_saved':fresh.revision===operation.item.revision+1&&fresh.choice===expected?'saved':'conflict'}));
 if(fresh.revision===operation.item.revision+1&&fresh.choice===expected){acceptSaved(fresh,operation);return 'saved';}
 if(fresh.revision===operation.item.revision)return 'not_saved';
 await conflict(operation.item,fresh);return 'conflict';
}
async function choose(choice,undo=false,target=null){
 if(busy||authRequired||pendingDecision)return;const item=target||items[index];if(!item||(!undo&&item.outcome==='external'))return;
 lock(true);message('保存しています…');const stamp=begin();const operation={item,choice,undo};
 try{
  pendingDecision=operation;let confirmed=false;
  try{
   const result=await api('/api/decision',{key:item.key,videoId:item.videoId,revision:item.revision,choice,undo});
   const expected=undo?item.previousChoice??null:choice;
   if(result.item.key!==item.key||result.item.revision!==item.revision+1||result.item.choice!==expected)throw failure('invalid_payload',{operation:'/api/decision'});
   pendingDecision=null;acceptSaved(result.item,operation);confirmed=true;
  }catch(error){
   if(error.status===409){pendingDecision=null;try{await conflict(item);}catch(freshError){showError(freshError,'最新データを取得できませんでした。');}return;}
   if(error.authSource==='worker'||[400,401,403,404,422].includes(error.status)){pendingDecision=null;showError(error);return;}
   // Never repeat POST: one read verifies whether an ambiguous save committed.
   if(error.authRelated){showError(error,'保存結果は未確認です。「更新」で最新revisionを確認してください。');return;}
   try{const outcome=await reconcilePending();confirmed=outcome==='saved';if(!confirmed){if(outcome==='not_saved')showError(error,'分類は未保存です。');return;}}
   catch(readError){showError(readError,'保存結果は未確認です。重複送信を防ぐため「更新」で照合してください。');return;}
  }
  if(confirmed){message(undo?'分類を取り消しました。':'保存しました。');render();try{await advance();}catch(error){showError(error,'分類は保存済みです。次のカードを取得できません。');}if(!authRequired)void refreshCounts(stamp);}
 }finally{lock(false);}
}
async function next(){if(busy)return;lock(true);try{if(items[index]){visited.add(items[index].key);lastCardKey=items[index].key;index++;}await advance();}catch(error){showError(error);}finally{lock(false);}}
async function reload(newMode=mode){
 if(busy)return;lock(true);const previous=mode;begin();let result='none';
 try{
  result=await reconcilePending();mode=newMode;await load(true);
  authRequired=false;el('recovery').hidden=true;
  message(result==='saved'?'前の分類は保存済みと確認できました。':result==='not_saved'?'前の分類は未保存でした。再操作できます。':result==='conflict'?errors[409]:items.length?'':'この一覧のカードはありません。');
 }catch(error){mode=previous;showError(error,result==='saved'?'前の分類は保存済みです。一覧を再取得できません。':pendingDecision?'保存結果は未確認です。':'');}
 finally{lock(false);}
}
async function showHistory(more=false){if(busy)return;lock(true);try{const data=await api('/api/history'+(more&&historyBefore?'?before='+historyBefore:''));historyBefore=data.next;const list=el('historyList').querySelector('ol');if(!more)list.replaceChildren();for(const event of data.events){const li=document.createElement('li');li.textContent=new Date(event.at).toLocaleString('ja-JP')+' '+event.name+' → '+(label[event.choice]||'未分類')+' / '+event.actor+' / '+event.action;list.append(li);}el('historyList').hidden=false;}catch(error){showError(error);}finally{lock(false);el('moreHistory').disabled=!historyBefore;}}
el('shorts').onclick=()=>choose('shorts');el('normal').onclick=()=>choose('normal');el('hold').onclick=()=>choose('hold');el('undo').onclick=()=>choose(null,true,last);el('next').onclick=next;
el('queue').onclick=()=>reload('queue');el('classified').onclick=()=>reload('classified');el('refresh').onclick=()=>reload();el('history').onclick=()=>showHistory();el('moreHistory').onclick=()=>showHistory(true);
document.addEventListener('keydown',e=>{if(busy||e.repeat||['INPUT','TEXTAREA','SELECT','A'].includes(e.target.tagName)||e.ctrlKey||e.metaKey||e.altKey)return;const choice={ArrowLeft:'shorts',ArrowRight:'normal',ArrowDown:'hold'}[e.key];if(choice){e.preventDefault();choose(choice);}});
let start=null;el('card').addEventListener('pointerdown',e=>{if(e.target.closest('a')||busy||!e.isPrimary||e.button!==0)return;start={id:e.pointerId,x:e.clientX,y:e.clientY,down:!!e.target.closest('#gesture'),key:items[index]?.key};});
el('card').addEventListener('pointercancel',()=>start=null);
el('card').addEventListener('pointerup',e=>{const s=start;start=null;if(!s||s.id!==e.pointerId||busy||s.key!==items[index]?.key)return;const dx=e.clientX-s.x,dy=e.clientY-s.y;if(Math.max(Math.abs(dx),Math.abs(dy))<65)return;if(Math.abs(dx)>Math.abs(dy)*1.4)choose(dx<0?'shorts':'normal');else if(s.down&&dy>65&&dy>Math.abs(dx)*1.4)choose('hold');});
reload();
`;
