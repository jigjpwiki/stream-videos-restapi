import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editorIdentity,syncAuthorized} from '../../ops/classifier/auth.mjs';
import worker from '../../ops/classifier/worker.mjs';
const env={ACCESS_ISSUER:'https://test-team.cloudflareaccess.com',ACCESS_AUD:'test-aud',EDITOR_EMAILS:'editor@example.com',SYNC_TOKEN:'a'.repeat(40)};
const now=Date.now();
const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'test-key'};
const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function jwt(extra={},head={}){const a=enc({alg:'RS256',kid:'test-key',...head}),b=enc({iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUD],email:'editor@example.com',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+300,...extra});const sig=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(a+'.'+b))).toString('base64url');return a+'.'+b+'.'+sig;}
const req=token=>new Request('https://editor.example.com/',{headers:{'Cf-Access-Jwt-Assertion':token}});
test('Access verifies RSA signature, issuer, audience, expiry, nbf and editor allowlist; forged header is insufficient',async()=>{
 const fetchImpl=async()=>new Response(JSON.stringify({keys:[jwk]}));
 assert.equal(await editorIdentity(req(await jwt()),env,fetchImpl,now),'editor@example.com');
 for(const claims of [{iss:'https://evil.com'},{aud:['wrong']},{exp:0},{email:'outsider@example.com'},{iat:Math.floor(now/1000)+3600},{nbf:Math.floor(now/1000)+3600}])await assert.rejects(editorIdentity(req(await jwt(claims)),env,fetchImpl,now));
 await assert.rejects(editorIdentity(req(await jwt({},{alg:'none'})),env,fetchImpl,now));
 await assert.rejects(editorIdentity(req((await jwt()).slice(0,-10)+'abcdefghi'),env,fetchImpl,now));
 await assert.rejects(editorIdentity(new Request('https://editor.example.com',{headers:{'Cf-Access-Authenticated-User-Email':'editor@example.com'}}),env,fetchImpl,now));
});
test('dedicated sync token cannot access editor APIs and editors cannot use internal API via forged actor',async()=>{
 const request=new Request('https://editor.example.com/internal/pending',{headers:{Authorization:'Bearer '+env.SYNC_TOKEN}});
 assert.equal(await syncAuthorized(request,env),true);assert.equal(await syncAuthorized(request,{SYNC_TOKEN:'short'}),false);
 const denied=await worker.fetch(new Request('https://editor.example.com/api/state',{headers:{Authorization:'Bearer '+env.SYNC_TOKEN}}),env);assert.equal(denied.status,401);
 const noInternal=await worker.fetch(new Request('https://editor.example.com/internal/pending',{headers:{'X-Actor':'actions'}}),env);assert.equal(noInternal.status,401);
});
test('authenticated browser mutation requires exact same origin and custom JSON request',async()=>{
 const token=await jwt();
 for(const headers of [{Origin:'https://evil.com'},{Origin:'https://editor.example.com'}]){
 const response=await worker.fetch(new Request('https://editor.example.com/api/decision',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token,...headers,'Content-Type':'application/json'},body:'{}'}),env);assert.equal(response.status,403);
 }
});

test('Access AJAX header retains same-origin and independent CSRF marker; legacy client remains compatible',async()=>{
 const token=await jwt();let mutations=0;const appEnv={...env,CLASSIFIER:{idFromName:()=>1,get:()=>({fetch:async request=>{mutations++;assert.ok(request.headers.get('X-Request-Id'));return Response.json({ok:true});}})}};
 for(const [origin,requested,marker,expected]of [
  ['https://evil.example','XMLHttpRequest','wiki-classifier',403],
  ['https://editor.example.com','XMLHttpRequest',undefined,403],
  ['https://editor.example.com','XMLHttpRequest','wrong',403],
  [undefined,'XMLHttpRequest','wiki-classifier',403],
  ['https://editor.example.com','XMLHttpRequest','wiki-classifier',200],
  ['https://editor.example.com','wiki-classifier',undefined,200],
 ]){
  const response=await worker.fetch(new Request('https://editor.example.com/api/decision',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token,'Content-Type':'application/json','X-Requested-With':requested,...(origin?{Origin:origin}:{}),...(marker?{'X-Classifier-Request':marker}:{})},body:'{}'}),appEnv);
  assert.equal(response.status,expected);assert.match(response.headers.get('X-Request-Id'),/^[a-f0-9-]{36}$/i);
 }
 assert.equal(mutations,2);
});

test('Worker auth causes are traceable: missing/expired/permission/key service failures remain distinct and fail closed',async t=>{
 const entries=[];t.mock.method(console,'info',value=>entries.push(value));
 let mutations=0;const appEnv={...env,CLASSIFIER:{idFromName:()=>1,get:()=>({fetch:async()=>{mutations++;return Response.json({ok:true});}})}};
 for(const [value,status,code,action] of [[null,401,'jwt_missing','reauthenticate'],[await jwt({exp:0}),401,'jwt_expired','reauthenticate'],[await jwt({aud:['wrong']}),403,'jwt_audience_mismatch','contact_admin'],[await jwt({email:'private-person@example.test'}),403,'editor_not_allowed','contact_admin']]){
  const response=await worker.fetch(new Request('https://editor.example.com/api/state?counts=1',{headers:value?{'Cf-Access-Jwt-Assertion':value}:{}}),appEnv);const data=await response.json();assert.equal(response.status,status);assert.equal(data.code,code);assert.equal(data.authSource,'worker');assert.equal(data.authAction,action);assert.equal(data.requestId,response.headers.get('X-Request-Id'));assert.equal(response.headers.get('X-Classifier-Auth-Source'),'worker');assert.ok(entries.some(entry=>entry.includes(data.requestId)&&entry.includes(code)));
 }
 t.mock.method(globalThis,'fetch',async()=>new Response('PRIVATE_TOKEN',{status:503}));
 const response=await worker.fetch(req(await jwt({}, {kid:'cold-key-for-service-test'})),appEnv);const data=await response.json();assert.equal(response.status,503);assert.equal(data.code,'auth_keys_http');assert.equal(data.authAction,'retry');assert.equal(mutations,0);
 assert.ok(entries.some(entry=>entry.includes(data.requestId)&&entry.includes('"upstreamStatus":503')));assert.ok(!entries.join('').includes('private-person'));assert.ok(!entries.join('').includes('PRIVATE_TOKEN'));assert.ok(!entries.join('').includes('Cf-Access-Jwt-Assertion'));
});
