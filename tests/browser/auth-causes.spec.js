import {test,expect} from '@playwright/test';
const id='a5f71002-10bb-4fa3-8442-9956053bad8c';
const items=Array.from({length:25},(_,i)=>({key:'A:'+String(i).padStart(11,'0'),videoId:'a'+String(i).padStart(10,'0'),name:'Fixture',page:'L',choice:null,revision:0,appliedRevision:0,present:true,outcome:'new',line:'-01/01 [[Fixture:https://youtu.be/a'+String(i).padStart(10,'0')+']]',metadata:{title:'認証 '+i,publishedAt:'2026-01-01T00:00:00Z',durationSeconds:60}}));
async function init(page,request){await request.post('/__reset',{data:{items}});await page.goto('/');await expect(page.locator('#title')).toHaveText('認証 0');}
async function action(page,button){await page.locator(button).click();await expect(page.locator('#refresh')).toBeEnabled();}
function denial(route,status,code){return route.fulfill({status,contentType:'application/json',headers:{'X-Request-Id':id,'X-Classifier-Auth-Source':'worker'},body:JSON.stringify({code,authSource:'worker',authAction:'IGNORED_UNTRUSTED_ACTION',requestId:id,jwt:'DO_NOT_LOG_JWT',email:'DO_NOT_LOG_EMAIL'})});}
test('every eighth counts fetch may fail without losing successful classification or demanding login for key service failures',async({page,request})=>{
 await init(page,request);let count=0;const logs=[];page.on('console',m=>{if(m.text().includes('classifier-ui'))logs.push(m.text());});
 await page.route('**/api/state?counts=1',async route=>{count++;if(count%8===0)await denial(route,503,'auth_keys_http');else await route.continue();});
 for(let i=0;i<24;i++){
  await expect(page.locator('#title')).toHaveText('認証 '+i);await action(page,'#shorts');await expect.poll(()=>count).toBe(i+1);
  if((i+1)%8===0){await expect(page.locator('#message')).toContainText('保存済み');await expect(page.locator('#message')).toContainText('公開鍵');await expect(page.locator('#message')).toContainText('auth_keys_http');await expect(page.locator('#reauth')).toBeHidden();await expect(page.locator('#shorts')).toBeEnabled();}
 }
 const state=await(await request.get('/api/state?counts=1')).json();expect(state.counts.classified).toBe(24);expect(logs.join('')).not.toContain('DO_NOT_LOG');expect(logs.join('')).toContain('"authSource":"worker"');
});
test('worker permission/config/signature errors are not Access expiry; only missing/expired JWT asks for authentication',async({page,request})=>{
 await init(page,request);
 for(const [status,code,text,reauth]of [[403,'editor_not_allowed','権限',false],[403,'jwt_signature_invalid','署名',false],[403,'jwt_audience_mismatch','audience',false],[503,'auth_keys_timeout','公開鍵',false],[500,'editor_configuration','許可リスト',false],[401,'jwt_missing','JWTが届いて',true],[401,'jwt_expired','有効期限',true]]){
  await page.route('**/api/state?counts=1',r=>denial(r,status,code),{times:1});await action(page,'#hold');
  await expect(page.locator('#message')).toContainText('保存済み');await expect(page.locator('#message')).toContainText(text);await expect(page.locator('#message')).toContainText(id);
  if(reauth){await expect(page.locator('#reauth')).toBeVisible();await expect(page.locator('#shorts')).toBeDisabled();}else{await expect(page.locator('#reauth')).toBeHidden();await expect(page.locator('#shorts')).toBeEnabled();}
  await action(page,'#refresh');
 }
});
test('key fetch failure on POST is rejected before mutation, does not trigger read/relogin loops and can be retried explicitly',async({page,request})=>{
 await init(page,request);let verificationReads=0;page.on('request',r=>{if(r.url().includes('/api/item?'))verificationReads++;});
 await page.route('**/api/decision',r=>denial(r,503,'auth_keys_network'),{times:1});await action(page,'#shorts');await expect(page.locator('#message')).toContainText('公開鍵');await expect(page.locator('#reauth')).toBeHidden();expect(verificationReads).toBe(0);
 await action(page,'#shorts');const history=await(await request.get('/api/history')).json();expect(history.events.length).toBe(1);
});
test('an unmarked 403 does not claim token expiry or force a new login',async({page,request})=>{
 await init(page,request);await page.route('**/api/state?counts=1',r=>r.fulfill({status:403,contentType:'text/html',body:'DO_NOT_LOG_EDGE_BODY'}),{times:1});
 await action(page,'#shorts');await expect(page.locator('#message')).toContainText('保存済み');await expect(page.locator('#message')).toContainText('HTTP 403');await expect(page.locator('#reauth')).toBeHidden();await expect(page.locator('#shorts')).toBeEnabled();
 await action(page,'#normal');const history=await(await request.get('/api/history')).json();expect(history.events.length).toBe(2);
});
