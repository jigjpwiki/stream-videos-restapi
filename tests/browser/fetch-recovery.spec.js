import {test,expect} from '@playwright/test';
const trace='12345678-1234-4234-8234-123456789abc';
const secret='NEVER_LOG_BODY_COOKIE_JWT_OR_REDIRECT_QUERY';
const rows=Array.from({length:12},(_,i)=>({key:'L:'+String(i).padStart(11,'0'),videoId:'v'+String(i).padStart(10,'0'),page:'L',name:'Fixture',line:'-01/01 [[Fixture:https://youtu.be/v'+String(i).padStart(10,'0')+']]',metadata:{title:'動画 '+i,publishedAt:'2025-01-01T00:00:00Z',durationSeconds:60},present:true,revision:0,appliedRevision:0,choice:null,outcome:'new'}));
async function init(page,request){await request.post('/__reset',{data:{items:rows}});await page.goto('/');await expect(page.locator('#title')).toHaveText('動画 0');}
async function action(page,id){await page.locator(id).click();await expect(page.locator('#refresh')).toBeEnabled();}
async function history(request){return (await (await request.get('/api/history')).json()).events;}

test('Access 302 during classification is an opaque redirect, not a network failure; in-page refresh recovers without replay',async({page,request})=>{
 const logs=[];page.on('console',msg=>{if(msg.text().includes('classifier-ui'))logs.push(msg.text());});
 await init(page,request);await action(page,'#shorts');await action(page,'#normal');
 await page.route('https://login.example.test/**',r=>r.fulfill({contentType:'text/html',body:secret}));
 await page.route('**/api/decision',r=>r.fulfill({status:302,headers:{Location:'https://login.example.test/cdn-cgi/access/login/?token='+secret},body:''}),{times:1});
 await action(page,'#shorts');await expect(page.locator('#message')).toContainText('転送');await expect(page.locator('#reauth')).toBeVisible();
 await expect(page.locator('#reauth')).toHaveAttribute('href','/');await expect(page.locator('#reauth')).toHaveAttribute('target','_blank');await expect(page.locator('#shorts')).toBeDisabled();
 await action(page,'#refresh');await expect(page.locator('#title')).toHaveText('動画 2');await expect(page.locator('#message')).toContainText('未保存');await expect(page.locator('#recovery')).toBeHidden();
 await action(page,'#shorts');expect((await history(request)).length).toBe(3);
 expect(logs.some(x=>x.includes('redirect_response'))).toBe(true);expect(logs.join('')).not.toContain(secret);
});
test('XMLHttpRequest header on every API returns explicit expired-session 401; separate CSRF marker remains on POST',async({page,request})=>{
 let expired=false;const seen=[];
 await page.route('**/api/**',async route=>{
  const r=route.request();seen.push(r.method());expect(r.headers()['x-requested-with']).toBe('XMLHttpRequest');
  if(r.method()==='POST')expect(r.headers()['x-classifier-request']).toBe('wiki-classifier');
  if(expired)await route.fulfill({status:401,contentType:'text/html',headers:{'cf-ray':'0123456789abcdef-NRT'},body:secret});else await route.continue();
 });
 await init(page,request);for(let i=0;i<3;i++)await action(page,'#shorts');expired=true;
 await action(page,'#normal');await expect(page.locator('#message')).toContainText('HTTP 401');await expect(page.locator('#message')).toContainText('cf-ray:');await expect(page.locator('#reauth')).toBeVisible();
 await action(page,'#refresh');await expect(page.locator('#refresh')).toBeEnabled();await expect(page.locator('#reauth')).toBeVisible();
 expired=false;await action(page,'#refresh');await expect(page.locator('#title')).toHaveText('動画 3');await action(page,'#normal');expect((await history(request)).length).toBe(4);expect(seen).toContain('GET');expect(seen).toContain('POST');
});
test('successful decision followed by HTML counts response keeps saved state and offers reauthentication',async({page,request})=>{
 const logs=[];page.on('console',m=>{if(m.text().includes('classifier-ui'))logs.push(m.text());});
 await init(page,request);await page.route('**/api/state?counts=1',r=>r.fulfill({status:200,contentType:'text/html',headers:{'X-Request-Id':trace},body:secret}),{times:1});
 await action(page,'#shorts');await expect(page.locator('#title')).toHaveText('動画 1');await expect(page.locator('#message')).toContainText('保存済み');await expect(page.locator('#message')).toContainText('HTML');await expect(page.locator('#message')).toContainText(trace);
 await expect(page.locator('#undo')).toBeDisabled();await action(page,'#refresh');await expect(page.locator('#recovery')).toBeHidden();await action(page,'#normal');expect((await history(request)).length).toBe(2);
 expect(logs.join('')).toContain('"contentType":"html"');expect(logs.join('')).not.toContain(secret);
});
test('HTML, non-JSON, invalid JSON/payload, and HTTP quota/server errors stay distinct and release refresh lock',async({page,request})=>{
 await init(page,request);
 for(const [status,type,body,text]of [[200,'text/html',secret,'HTML'],[200,'text/plain',secret,'JSON以外'],[200,'application/json','{'+secret,'JSON応答'],[200,'application/json','null','形式'],[429,'text/html',secret,'制限'],[503,'text/html',secret,'サーバー']]){
  await page.route('**/api/state?mode=queue',r=>r.fulfill({status,contentType:type,headers:{'X-Request-Id':trace},body}),{times:1});
  await action(page,'#refresh');await expect(page.locator('#message')).toContainText(text);await expect(page.locator('#message')).toContainText('HTTP '+status);await expect(page.locator('#message')).not.toContainText(secret);
  await action(page,'#refresh');await expect(page.locator('#shorts')).toBeEnabled();
 }
});
test('committed POST with lost response and failed revision read stays locked until refresh verifies revision exactly once',async({page,request})=>{
 await init(page,request);let posts=0;
 await page.route('**/api/decision',async route=>{posts++;await route.fetch();await route.abort();},{times:1});
 await page.route('**/api/item?key=*',r=>r.fulfill({status:200,contentType:'text/html',body:secret}),{times:1});
 await action(page,'#shorts');await expect(page.locator('#message')).toContainText('未確認');await expect(page.locator('#shorts')).toBeDisabled();
 await page.locator('#shorts').evaluate(e=>e.click());expect(posts).toBe(1);
 await action(page,'#refresh');await expect(page.locator('#message')).toContainText('保存済み');await expect(page.locator('#title')).toHaveText('動画 1');expect((await history(request)).length).toBe(1);
 await action(page,'#undo');expect((await history(request)).length).toBe(2);await expect(page.locator('#title')).toHaveText('動画 0');
});
test('commit returned HTML then revision verification succeeds but list fails: saved confirmation is retained',async({page,request})=>{
 await init(page,request);
 await page.route('**/api/decision',async route=>{await route.fetch();await route.fulfill({status:200,contentType:'text/html',body:secret});},{times:1});
 await action(page,'#shorts');await expect(page.locator('#message')).toContainText('未確認');
 await page.route('**/api/state?mode=queue',r=>r.fulfill({status:200,contentType:'text/html',body:secret}),{times:1});
 await action(page,'#refresh');await expect(page.locator('#message')).toContainText('保存済み');await expect(page.locator('#message')).toContainText('HTML');
 await action(page,'#refresh');await expect(page.locator('#title')).toHaveText('動画 1');expect((await history(request)).length).toBe(1);
});
test('500 after commit is verified with GET, never repeated POST; failed POST with no commit can explicitly retry after verification',async({page,request})=>{
 await init(page,request);
 await page.route('**/api/decision',async route=>{await route.fetch();await route.fulfill({status:500,contentType:'application/json',body:'{}'});},{times:1});
 await action(page,'#shorts');await expect(page.locator('#title')).toHaveText('動画 1');expect((await history(request)).length).toBe(1);
 await page.route('**/api/decision',r=>r.abort(),{times:1});await page.route('**/api/item?key=*',r=>r.abort(),{times:1});
 await action(page,'#normal');await expect(page.locator('#shorts')).toBeDisabled();await expect(page.locator('#message')).toContainText('未確認');
 await action(page,'#refresh');await expect(page.locator('#message')).toContainText('未保存');await action(page,'#normal');expect((await history(request)).length).toBe(2);
});
test('late counts failure cannot overwrite a newer successful refresh or keep operation lock',async({page,request})=>{
 await init(page,request);let finish,started;
 const ready=new Promise(resolve=>started=resolve);
 await page.route('**/api/state?counts=1',async route=>{started();await new Promise(resolve=>finish=resolve);try{await route.fulfill({status:200,contentType:'text/html',body:secret});}catch{}},{times:1});
 await action(page,'#shorts');await ready;await action(page,'#refresh');finish();
 await expect(page.locator('#recovery')).toBeHidden();await expect(page.locator('#shorts')).toBeEnabled();await action(page,'#normal');await expect(page.locator('#title')).toHaveText('動画 2');
});
test('malformed card/history payloads and stalled history release every operation lock and recover through refresh',async({page,request})=>{
 await init(page,request);
 const state=await (await request.get('/api/state')).json();state.items[0].line=42;
 await page.route('**/api/state?mode=queue',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(state)}),{times:1});
 await action(page,'#refresh');await expect(page.locator('#message')).toContainText('形式');await action(page,'#refresh');await expect(page.locator('#title')).toHaveText('動画 0');
 await page.route('**/api/history',r=>r.fulfill({contentType:'application/json',body:'{"events":[null]}'}),{times:1});await action(page,'#history');await expect(page.locator('#message')).toContainText('形式');
 await page.clock.install();let stalled;await page.route('**/api/history',route=>{stalled=route;},{times:1});await page.locator('#history').click();await page.clock.fastForward(16000);await expect(page.locator('#refresh')).toBeEnabled();await expect(page.locator('#message')).toContainText('タイムアウト');await stalled.abort();
 await action(page,'#refresh');await action(page,'#normal');await expect(page.locator('#title')).toHaveText('動画 1');
});
test('60 classifications with periodic auth, HTML, 302, 5xx and network faults recover in-page without duplicate history',async({page,request})=>{
 const many=Array.from({length:61},(_,i)=>({...rows[0],key:'S:'+String(i).padStart(11,'0'),videoId:'s'+String(i).padStart(10,'0'),metadata:{...rows[0].metadata,title:'連続 '+i}}));
 await request.post('/__reset',{data:{items:many}});await page.goto('/');
 for(let i=0;i<60;i++){
  await expect(page.locator('#title')).toHaveText('連続 '+i);
  if(i===5||i===15){await page.route('**/api/decision',r=>r.fulfill({status:i===5?401:503,contentType:'text/html',body:secret}),{times:1});await action(page,'#shorts');await action(page,'#refresh');}
  if(i===25){await page.route('**/api/decision',r=>r.abort(),{times:1});await page.route('**/api/item?key=*',r=>r.abort(),{times:1});await action(page,'#shorts');await expect(page.locator('#shorts')).toBeDisabled();await action(page,'#refresh');}
  if(i===35){await page.route('**/api/decision',async r=>{await r.fetch();await r.fulfill({contentType:'text/html',body:secret});},{times:1});await action(page,'#shorts');await action(page,'#refresh');continue;}
  if(i===55){await page.route('**/api/decision',r=>r.fulfill({status:302,headers:{Location:'https://login.example.test/cdn-cgi/access/login/'},body:''}),{times:1});await action(page,'#shorts');await action(page,'#refresh');}
  if(i===45)await page.route('**/api/state?counts=1',r=>r.fulfill({contentType:'text/html',body:secret}),{times:1});
  await action(page,'#shorts');
  if(i===45){await expect(page.locator('#reauth')).toBeVisible();await action(page,'#refresh');}
 }
 await expect(page.locator('#title')).toHaveText('連続 60');
 const state=await(await request.get('/api/state?counts=1')).json();expect(state.counts.classified).toBe(60);
 const a=await(await request.get('/api/history')).json(),b=await(await request.get('/api/history?before='+a.next)).json();expect(a.events.length+b.events.length).toBe(60);
});
test('production CSP remains enforced; connection violations log only a fixed code without blocked URL',async({page,request})=>{
 const logs=[];page.on('console',m=>{if(m.text().includes('"component":"classifier-ui"'))logs.push(m.text());});
 await init(page,request);await page.evaluate(async value=>{try{await fetch('https://login.example.test/blocked?token='+value);}catch{}},secret);
 await expect.poll(()=>logs.some(x=>x.includes('csp_connect_blocked'))).toBe(true);expect(logs.join('')).not.toContain(secret);expect(logs.join('')).not.toContain('https://login.example.test');
 await action(page,'#shorts');await expect(page.locator('#title')).toHaveText('動画 1');
});
