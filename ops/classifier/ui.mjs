export const HTML=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>動画の分類</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><main><header><p class="eyebrow">JIGJP WIKI / EDITOR</p><h1>動画の分類</h1><p>Shortsと投稿動画を、ひとつずつ整理。</p></header><section id="counts" aria-label="分類件数"></section><nav><button id="queue">未分類・保留</button><button id="classified">分類済み・修正</button><button id="history">履歴</button><button id="refresh">更新</button></nav><p id="message" role="status" aria-live="polite"></p><article id="card" tabindex="0"><img id="thumbnail" alt="動画のサムネイル" draggable="false"><div class="info"><p id="name"></p><h2 id="title"></h2><p id="meta"></p><p id="status"></p><a id="link" target="_blank" rel="noopener noreferrer">YouTubeで確認 ↗</a></div><p id="gesture">ここで左右・下にスワイプして分類</p></article><section id="actions" aria-label="分類操作"><button id="shorts">← Shorts</button><button id="hold">↓ 保留</button><button id="normal">投稿動画 →</button></section><p class="hint">左右・下にスワイプ / 矢印キーでも操作できます。</p><div class="toolbar"><button id="undo" disabled>直前の分類を取り消す</button><button id="next">次のカード</button></div><section id="historyList" hidden><h2>変更履歴</h2><ol></ol><button id="moreHistory">前の履歴</button></section><footer>分類は保存後、次回以降の同期でWikiへ反映します。Wikiでの手動分類を優先します。</footer></main></body></html>`;
export const CSS=`:root{font-family:system-ui,sans-serif;color:#1c2937;background:#eef2f4}*{box-sizing:border-box}body{margin:0}main{max-width:800px;margin:auto;padding:30px 20px 50px}header{margin:10px 0 24px}.eyebrow{font-size:12px;letter-spacing:.15em;color:#546875;font-weight:700}h1{font-size:32px;margin:8px 0}header>p:last-child{color:#526270}#counts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px}#counts div{background:white;border-radius:12px;padding:14px 8px;text-align:center;font-size:12px;color:#526270}#counts strong{display:block;font-size:24px;color:#1c2937}nav,.toolbar{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;font-size:14px;padding:12px 16px;background:white;border:1px solid #b8c5cb;border-radius:10px;cursor:pointer;color:#253a47;min-height:46px}button:disabled{opacity:.45;cursor:wait}button:focus-visible,a:focus-visible{outline:3px solid #008075;outline-offset:3px}#message{min-height:24px;color:#8c3c1e}article{overflow:hidden;border-radius:18px;background:white;box-shadow:0 12px 30px #143c4f12;touch-action:pan-y} #gesture{touch-action:none;font-size:12px;color:#657681;padding:12px 20px;margin:0}article img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#d5dfe4}.info{padding:18px 22px 24px}#name{color:#00786b;font-weight:700;margin:0 0 8px}h2{font-size:21px;line-height:1.5;margin:0 0 10px}#meta,#status{font-size:14px;color:#526270}a{color:#00786b;text-underline-offset:3px}#actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:16px}#shorts{background:#e5f3f1;border-color:#73aaa2}#normal{background:#e7effa;border-color:#8da9d1}.hint,footer{font-size:12px;color:#657681;line-height:1.8}.hint{text-align:center;margin:14px 0 20px}.toolbar{justify-content:space-between}footer{margin-top:30px}#historyList{background:white;padding:20px;margin-top:24px;border-radius:12px}li{margin:12px 0;line-height:1.6;font-size:14px}li button{margin-left:8px;padding:5px 10px;min-height:36px}@media(max-width:480px){main{padding:18px 12px 35px}h1{font-size:27px}#counts div{padding:10px 4px;font-size:11px}#counts strong{font-size:22px}button{padding:10px;font-size:13px}.info{padding:16px}h2{font-size:18px}}`;
export const JS=String.raw`
const el=id=>document.getElementById(id);
let items=[],index=0,mode='queue',cursor=null,busy=false,last=null,historyBefore=null,counts={},version=0;
let visited=new Set(),deferred=[],deferredPass=false,lastCardKey=null;
const label={shorts:'Shorts',normal:'投稿動画',hold:'保留',uncategorized:'未分類'};
const errors={400:'操作内容が不正です。更新して再操作してください。',401:'認証が切れました。再ログインしてください。',403:'編集権限または認証を確認してください。',409:'他の編集が入りました。最新データを確認して再操作してください。',500:'サーバーで処理できませんでした。少し待って再操作してください。'};
async function api(path,data){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  const r=await fetch(path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json','X-Requested-With':'wiki-classifier'}:{},body:data?JSON.stringify(data):undefined,credentials:'same-origin',signal:controller.signal});
  if(!r.ok){let info={};try{info=await r.json();}catch{}const e=Error(errors[r.status]||(r.status>=500?errors[500]:'取得できませんでした。更新してください。'));e.status=r.status;
   console.warn(JSON.stringify({component:'classifier-ui',operation:path.split('?')[0],status:r.status,requestId:/^[\w-]{36}$/.test(info.requestId||'')?info.requestId:undefined}));throw e;}
  try{return await r.json();}catch{throw Error('応答を確認できませんでした。更新して確認してください。');}
 }catch(e){if(e.status)throw e;console.warn(JSON.stringify({component:'classifier-ui',operation:path.split('?')[0],code:controller.signal.aborted?'timeout':'connection_or_response'}));throw Error(controller.signal.aborted?'通信がタイムアウトしました。更新して確認してください。':'通信を確認できませんでした。更新して確認してください。');}
 finally{clearTimeout(timer);}
}
function message(text){el('message').textContent=text;}
function lock(value){busy=value;for(const id of ['next','refresh','queue','classified','history','moreHistory'])el(id).disabled=value;el('undo').disabled=value||!last;render();}
function render(){
 const item=items[index];el('card').hidden=!item;el('actions').hidden=!item;el('next').hidden=!item&&!cursor;
 for(const id of ['shorts','normal','hold'])el(id).disabled=busy||!item||item.outcome==='external';
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
 items=data.items.filter(item=>!visited.has(item.key));index=0;cursor=data.nextCursor??null;showCounts(data.counts);render();}
async function advance(){
 while(index>=items.length&&cursor)await load();
 if(index>=items.length){
  if(!deferredPass&&deferred.length&&(deferred.length>1||deferred[0].key!==lastCardKey)){items=deferred;deferred=[];index=0;deferredPass=true;}
  else {items=[];index=0;message('この巡回は完了しました。保留は「更新」で再確認できます。');}
 }
 render();
}
async function refreshCounts(stamp){try{const data=await api('/api/state?counts=1');if(version===stamp)showCounts(data.counts);}catch{if(version===stamp&&!busy)message('分類は保存済みです。件数の再取得に失敗しました。「更新」で確認できます。');}}
async function conflict(item){
 try{const {item:fresh}=await api('/api/item?key='+encodeURIComponent(item.key));const at=items.findIndex(v=>v.key===fresh.key);if(mode==='queue'&&(['shorts','normal'].includes(fresh.choice)||fresh.outcome==='external')){visited.add(fresh.key);if(at>=0)items.splice(at,1);await advance();}else if(at>=0)items[at]=fresh;else items.splice(index,0,fresh);render();message(errors[409]);}
 catch{message('最新データを取得できません。「更新」してから再操作してください。');}
}
async function choose(choice,undo=false,target=null){
 if(busy)return;const item=target||items[index];if(!item||(!undo&&item.outcome==='external'))return;
 lock(true);message('保存しています…');const stamp=++version;let result;
 try{
  try{result=await api('/api/decision',{key:item.key,videoId:item.videoId,revision:item.revision,choice,undo});}
  catch(error){
   if(error.status===409){await conflict(item);return;}
   if(!error.status){try{const fresh=(await api('/api/item?key='+encodeURIComponent(item.key))).item;const expected=undo?item.previousChoice??null:choice;if(fresh.revision===item.revision+1&&fresh.choice===expected)result={item:fresh};}catch{}}
   if(!result){message(error.message);return;}
  }
  const updated=result.item;last=undo?null:updated;
  if(undo){
   visited.delete(updated.key);deferred=deferred.filter(v=>v.key!==updated.key);
   items=items.filter(v=>v.key!==updated.key);index=Math.min(index,items.length);items.splice(index,0,updated);
  }else if(mode==='queue'){
   visited.add(item.key);lastCardKey=item.key;items.splice(index,1);
   if(choice==='hold'&&!deferredPass)deferred.push(updated);
  }else items[index]=updated;
  message(undo?'分類を取り消しました。':'保存しました。');render();
  try{await advance();}catch{message('分類は保存済みです。次のカードを取得できません。「次のカード」か「更新」で再開できます。');}
  void refreshCounts(stamp);
 }finally{lock(false);}
}
async function next(){if(busy)return;lock(true);try{if(items[index]){visited.add(items[index].key);lastCardKey=items[index].key;index++;}await advance();}catch(e){message(e.message);}finally{lock(false);}}
async function reload(newMode=mode){if(busy)return;lock(true);const previous=mode;mode=newMode;++version;try{await load(true);message(items.length?'':'この一覧のカードはありません。');}catch(e){mode=previous;message(e.message);}finally{lock(false);}}
async function showHistory(more=false){if(busy)return;lock(true);try{const data=await api('/api/history'+(more&&historyBefore?'?before='+historyBefore:''));historyBefore=data.next;const list=el('historyList').querySelector('ol');if(!more)list.replaceChildren();for(const event of data.events){const li=document.createElement('li');li.textContent=new Date(event.at).toLocaleString('ja-JP')+' '+event.name+' → '+(label[event.choice]||'未分類')+' / '+event.actor+' / '+event.action;list.append(li);}el('historyList').hidden=false;}catch(e){message(e.message);}finally{lock(false);el('moreHistory').disabled=!historyBefore;}}
el('shorts').onclick=()=>choose('shorts');el('normal').onclick=()=>choose('normal');el('hold').onclick=()=>choose('hold');el('undo').onclick=()=>choose(null,true,last);el('next').onclick=next;
el('queue').onclick=()=>reload('queue');el('classified').onclick=()=>reload('classified');el('refresh').onclick=()=>reload();el('history').onclick=()=>showHistory();el('moreHistory').onclick=()=>showHistory(true);
document.addEventListener('keydown',e=>{if(busy||e.repeat||['INPUT','TEXTAREA','SELECT','A'].includes(e.target.tagName)||e.ctrlKey||e.metaKey||e.altKey)return;const choice={ArrowLeft:'shorts',ArrowRight:'normal',ArrowDown:'hold'}[e.key];if(choice){e.preventDefault();choose(choice);}});
let start=null;el('card').addEventListener('pointerdown',e=>{if(e.target.closest('a')||busy||!e.isPrimary||e.button!==0)return;start={id:e.pointerId,x:e.clientX,y:e.clientY,down:!!e.target.closest('#gesture'),key:items[index]?.key};});
el('card').addEventListener('pointercancel',()=>start=null);
el('card').addEventListener('pointerup',e=>{const s=start;start=null;if(!s||s.id!==e.pointerId||busy||s.key!==items[index]?.key)return;const dx=e.clientX-s.x,dy=e.clientY-s.y;if(Math.max(Math.abs(dx),Math.abs(dy))<65)return;if(Math.abs(dx)>Math.abs(dy)*1.4)choose(dx<0?'shorts':'normal');else if(s.down&&dy>65&&dy>Math.abs(dx)*1.4)choose('hold');});
reload();
`;
