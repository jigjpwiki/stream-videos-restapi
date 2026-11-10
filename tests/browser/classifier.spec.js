import {test,expect} from '@playwright/test';
import {decide,pending} from '../../ops/classifier/model.mjs';
const id='abcdefghijk';
test('card, counts, keyboard/swipe, hold, undo, revision failure, correction and history',async({page},testInfo)=>{
 let item={key:encodeURIComponent('L/動画一覧')+':'+id,videoId:id,name:'テストライバー',page:'L/動画一覧',line:'-01/01 [[Title:https://youtu.be/'+id+']]',metadata:{title:'過去の動画 <script>danger</script>',publishedAt:'2025-01-01T00:00:00Z',durationSeconds:61},present:true,choice:null,revision:0,appliedRevision:0,outcome:'new'};
 let conflict=false;const choices=[];
 await page.route('**/api/**',async route=>{
 const request=route.request(),url=new URL(request.url());let data;
 if(url.pathname==='/api/state'){const queue=url.searchParams.get('mode')!=='classified';data={items:queue?(item.choice===null||item.choice==='hold'?[item]:[]):[item],next:null,counts:{unclassified:item.choice===null?1:0,classified:['shorts','normal'].includes(item.choice)?1:0,awaiting:pending(item)?1:0,held:item.choice==='hold'?1:0}};}
 else if(url.pathname==='/api/history')data={events:[{at:'2026-11-10T00:00:00Z',name:item.name,choice:'shorts',actor:'editor@example.com',action:'decision'}]};
 else if(url.pathname==='/api/decision'){
 expect(request.headers()['x-requested-with']).toBe('wiki-classifier');
 if(conflict){await route.fulfill({status:409,contentType:'application/json',body:'{}'});return;}
 const body=request.postDataJSON();item=decide(item,body,'editor@example.com','2026-11-10T00:00:00Z');choices.push(item.choice);data={item};
 }else throw Error(url.pathname);
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('/');await expect(page.locator('#title')).toContainText('<script>danger</script>');await expect(page.locator('#meta')).toContainText('1:01');
 await expect(page.locator('#link')).toHaveAttribute('href','https://www.youtube.com/watch?v='+id);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'work/classifier-'+testInfo.project.name+'.png',fullPage:true});
 if(testInfo.project.name==='desktop'){await page.locator('#card').focus();await page.keyboard.press('ArrowLeft');}
 else {
 const box=await page.locator('#card').boundingBox();const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width-20,y:box.y+40}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+20,y:box.y+40}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
 }
 await expect(page.locator('#card')).toBeHidden();expect(choices).toEqual(['shorts']);
 await page.locator('#undo').click();await expect(page.locator('#card')).toBeVisible();expect(choices).toEqual(['shorts',null]);
 // Down gesture and keyboard defer the current card.
 await page.locator('#card').focus();await page.keyboard.press('ArrowDown');await expect(page.locator('#status')).toContainText('保留');expect(choices.at(-1)).toBe('hold');
 conflict=true;await page.locator('#normal').click();await expect(page.locator('#message')).toContainText('他の編集');expect(choices.at(-1)).toBe('hold');
 conflict=false;await page.locator('#normal').click();await expect(page.locator('#card')).toBeHidden();
 await page.locator('#classified').click();await expect(page.locator('#status')).toContainText('投稿動画');await page.locator('#shorts').click();await expect(page.locator('#status')).toContainText('Shorts');
 await page.locator('#history').click();await expect(page.locator('#historyList')).toContainText('editor@example.com');
});
