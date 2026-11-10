import {createWikiRateLimit} from '../../src/services/wikiHttp.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {httpClient,HttpRequestError,requestErrorDetails} from '../../src/schedule/http.js';
import {videoWikiClient,WikiPageNotFoundError} from '../../src/services/wikiwiki.js';
const env={WIKI_API_BASE_URL:'https://api.wikiwiki.jp/jigjp',WIKI_PASSWORD:'SECRET_PASSWORD'};

test('HTTP errors retain only safe status/code; existing three attempts and backoff are preserved',async()=>{
 for(const status of [401,403,404,429,500,503]) {
  let calls=0;const delays=[];
  const request=httpClient(async()=>{calls++;return new Response('SECRET_BODY',{status});},async ms=>delays.push(ms));
  await assert.rejects(request('Wiki GET','https://example.test/?token=SECRET_TOKEN'),error=>{
   assert.ok(error instanceof HttpRequestError);assert.equal(error.message,'Wiki GET failed');
   assert.deepEqual(requestErrorDetails(error),{reason:'http_error',status});
   assert.ok(!JSON.stringify(error).includes('SECRET'));assert.equal(error.cause,undefined);return true;
  });
  assert.equal(calls,3);assert.deepEqual(delays,[1000,2000]);
 }
});
test('timeouts, transport errors and malformed JSON remain distinct from HTTP 404',async()=>{
 for(const [failure,reason,status]of [
  [()=>{throw new DOMException('SECRET','TimeoutError');},'timeout'],
  [()=>{throw new DOMException('SECRET','AbortError');},'timeout'],
  [()=>{throw new TypeError('SECRET_CONNECTION');},'network_error'],
  [()=>new Response('SECRET_INVALID_JSON'),'invalid_response',200],
 ]) {
  let calls=0;const request=httpClient(async()=>{calls++;return failure();},async()=>{});
  await assert.rejects(request('Wiki GET','https://example.test'),error=>{
   assert.deepEqual(requestErrorDetails(error),{reason,...(status?{status}:{})});assert.ok(!JSON.stringify(error).includes('SECRET'));return true;
  });assert.equal(calls,3);
 }
 assert.deepEqual(requestErrorDetails(Object.assign(new Error('SECRET'),{code:'page_not_found',status:404})),{reason:'operation_failed'});
});
test('PUT is never retried for HTTP errors, timeout or ambiguous transport failure',async()=>{
 for(const failure of [()=>new Response('SECRET',{status:404}),()=>new Response('SECRET',{status:429}),()=>new Response('SECRET',{status:503}),()=>{throw new DOMException('SECRET','TimeoutError');},()=>{throw Error('SECRET');}]) {
  let calls=0;const request=httpClient(async()=>{calls++;return failure();},async()=>assert.fail('PUT backoff prohibited'));
  await assert.rejects(request('Wiki PUT','https://example.test',{method:'PUT'}));assert.equal(calls,1);
 }
});
test('only authenticated page GET HTTP 404 becomes WikiPageNotFoundError (not auth 404 or body status)',async()=>{
 await Promise.all(['page404','auth404','authMalformed','body404','empty','noSection','malformed'].map(async mode=>{
  let pageCalls=0;
  const client=videoWikiClient(env,async url=>{
   if(url.endsWith('/auth'))return mode==='auth404'?new Response('SECRET',{status:404}):Response.json(mode==='authMalformed'?null:{token:'SECRET_TOKEN'});
   pageCalls++;
   if(mode==='page404')return Response.json({status:404,error:'SECRET_BODY'},{status:404});
   if(mode==='body404')return Response.json({status:404,error:'not found'});
   if(mode==='malformed')return Response.json(null);
   return Response.json({source:mode==='empty'?'':'本文のみ'});
  },{rateLimit:createWikiRateLimit({sleep:async()=>{},intervalMs:0})});
  if(mode==='empty'||mode==='noSection')assert.equal(await client.get('page'),mode==='empty'?'':'本文のみ');
  else await assert.rejects(client.get('page'),error=>{
   assert.equal(error instanceof WikiPageNotFoundError,mode==='page404');
   assert.equal(error.code,mode==='page404'?'page_not_found':mode==='auth404'?'http_error':'invalid_response');
   if(mode==='auth404'){assert.equal(pageCalls,0);assert.equal(error.status,404);}
   assert.ok(!JSON.stringify(error).includes('SECRET'));return true;
  });
 }));
});
