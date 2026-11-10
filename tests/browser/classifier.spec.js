import {test,expect} from '@playwright/test';
const fixtures=(n=61)=>Array.from({length:n},(_,i)=>({key:'L:'+String(i).padStart(11,'0'),videoId:'v'+String(i).padStart(10,'0'),name:'テストライバー',page:'L',line:'-01/01 [[元のタイトル:https://youtu.be/v'+String(i).padStart(10,'0')+']]',metadata:{title:'動画 '+i,publishedAt:'2025-01-01T00:00:00Z',durationSeconds:61},present:true,choice:null,revision:0,appliedRevision:0,outcome:'new'}));
async function init(page,request,n=61){await request.post('/__reset',{data:{items:fixtures(n)}});await page.goto('/');await expect(page.locator('#title')).toHaveText('動画 0');}
async function save(page,id){await page.locator(id).click();await expect(page.locator('#refresh')).toBeEnabled();}
test('60 continuous classifications cross the 50-item SQL cursor boundary without reload or duplicate requests',async({page,request})=>{
 await init(page,request);let documents=0;page.on('request',r=>{if(r.isNavigationRequest())documents++;});
 for(let i=0;i<60;i++){await expect(page.locator('#title')).toHaveText('動画 '+i);await save(page,i%2?'#normal':'#shorts');}
 await expect(page.locator('#title')).toHaveText('動画 60');expect(documents).toBe(0);
 const state=await (await request.get('/api/state?counts=1')).json();expect(state.counts.classified).toBe(60);expect(state.counts.unclassified).toBe(1);
});
test('hold goes to tour end once; undo and classified correction preserve position',async({page,request})=>{
 await init(page,request,3);await save(page,'#hold');await expect(page.locator('#title')).toHaveText('動画 1');
 await save(page,'#shorts');await expect(page.locator('#title')).toHaveText('動画 2');await save(page,'#normal');await expect(page.locator('#title')).toHaveText('動画 0');
 await save(page,'#hold');await expect(page.locator('#card')).toBeHidden();
 await save(page,'#undo');await expect(page.locator('#title')).toHaveText('動画 0');await save(page,'#normal');
 await save(page,'#classified');await save(page,'#next');await expect(page.locator('#title')).toHaveText('動画 1');
 await save(page,'#normal');await expect(page.locator('#title')).toHaveText('動画 1');await expect(page.locator('#status')).toContainText('投稿動画');
 await save(page,'#history');await expect(page.locator('#historyList')).toContainText('test@example.com');
});
test('single hold ends tour, refresh starts a new tour; double click is one CAS request',async({page,request})=>{
 await init(page,request,1);let posts=0;await page.route('**/api/decision',async route=>{posts++;await new Promise(r=>setTimeout(r,100));await route.continue();});
 await page.locator('#hold').evaluate(button=>{button.click();button.click();});await expect(page.locator('#refresh')).toBeEnabled();await expect(page.locator('#card')).toBeHidden();expect(posts).toBe(1);
 await save(page,'#refresh');await expect(page.locator('#title')).toHaveText('動画 0');
});
test('safe 400/auth/500 messages, connection recovery, successful save survives counts failure',async({page,request})=>{
 await init(page,request,4);
 for(const [status,text]of [[400,'操作内容'],[401,'認証が切れ'],[403,'編集権限'],[500,'サーバー']]){
 await page.route('**/api/decision',r=>r.fulfill({status,body:'SECRET_SERVER_BODY'}),{times:1});await save(page,'#shorts');await expect(page.locator('#message')).toContainText(text);await expect(page.locator('#title')).toHaveText('動画 0');}
 await page.route('**/api/decision',r=>r.abort(),{times:1});await save(page,'#shorts');await expect(page.locator('#message')).toContainText('通信');
 await page.route('**/api/state?counts=1',r=>r.fulfill({status:503,body:'SECRET'}),{times:1});await save(page,'#shorts');await expect(page.locator('#title')).toHaveText('動画 1');await expect(page.locator('#message')).toContainText('保存済み');
 await save(page,'#normal');await expect(page.locator('#title')).toHaveText('動画 2');
});
test('two tabs race: stale revision refreshes the card and requires an explicit second choice',async({page,context,request})=>{
 await init(page,request,2);const other=await context.newPage();await other.goto('/');await expect(other.locator('#title')).toHaveText('動画 0');
 await save(other,'#hold');await save(page,'#shorts');await expect(page.locator('#message')).toContainText('他の編集');await expect(page.locator('#status')).toContainText('保留');
 await save(page,'#normal');await expect(page.locator('#title')).toHaveText('動画 1');
});
test('pointer gestures share save path, vertical scroll stays native outside explicit gesture strip',async({page,request},info)=>{
 await init(page,request,3);expect(await page.locator('#card').evaluate(e=>getComputedStyle(e).touchAction)).toBe('pan-y');
 await page.locator('#gesture').scrollIntoViewIfNeeded();const box=await page.locator('#gesture').boundingBox();const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width-10,y:box.y+10}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+10,y:box.y+10}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await expect(page.locator('#title')).toHaveText('動画 1');
 await page.locator('#card').focus();await page.keyboard.press('ArrowRight');await expect(page.locator('#title')).toHaveText('動画 2');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'work/stable-ui-'+info.project.name+'.png',fullPage:true});
 await cdp.detach();
});
test('saved boundary item stays saved when next page fails; request timeout unlocks controls',async({page,request})=>{
 await init(page,request,52);
 for(let i=0;i<49;i++)await save(page,'#shorts');
 await page.route('**/api/state?mode=queue&cursor=*',r=>r.fulfill({status:503,body:'SECRET'}),{times:1});
 await save(page,'#normal');await expect(page.locator('#message')).toContainText('保存済み');
 await save(page,'#next');await expect(page.locator('#title')).toHaveText('動画 50');
 await page.clock.install();let stalled;
 await page.route('**/api/decision',async route=>{stalled=route;});
 await page.locator('#shorts').click();await page.clock.fastForward(16000);await expect(page.locator('#refresh')).toBeEnabled();await expect(page.locator('#message')).toContainText('タイムアウト');
 await stalled.abort();await page.unroute('**/api/decision');await save(page,'#shorts');await expect(page.locator('#title')).toHaveText('動画 51');
});
test('cloud-managed row remains editable without Wiki presence, survives hold, classification and undo',async({page,request})=>{
 const items=fixtures(2).map(item=>({...item,present:false,authority:'cloudflare',custody:{phase:'committed',origin:'wiki',line:item.line}}));
 await request.post('/__reset',{data:{items}});await page.goto('/');await expect(page.locator('#title')).toHaveText('動画 0');
 await save(page,'#hold');await expect(page.locator('#title')).toHaveText('動画 1');await save(page,'#shorts');await expect(page.locator('#title')).toHaveText('動画 0');await save(page,'#normal');await expect(page.locator('#card')).toBeHidden();
 await save(page,'#undo');await expect(page.locator('#title')).toHaveText('動画 0');await expect(page.locator('#status')).toContainText('保留');
});
