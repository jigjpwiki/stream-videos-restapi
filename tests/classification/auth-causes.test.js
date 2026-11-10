import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEditorIdentity,AuthError} from '../../ops/classifier/auth.mjs';
const env={ACCESS_ISSUER:'https://auth-tests.cloudflareaccess.com',ACCESS_AUD:'expected-aud',EDITOR_EMAILS:'allowed@example.test'};
const start=Date.now();
async function signing(kid){const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);return {keys,jwk:{...await crypto.subtle.exportKey('jwk',keys.publicKey),kid}};}
const first=await signing('first'),second=await signing('second');
const enc=data=>Buffer.from(JSON.stringify(data)).toString('base64url');
async function token(signer=first,claims={},head={}){const a=enc({alg:'RS256',kid:signer.jwk.kid,...head}),b=enc({iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUD],exp:Math.floor(start/1000)+3600,iat:Math.floor(start/1000),email:'allowed@example.test',...claims});return a+'.'+b+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',signer.keys.privateKey,new TextEncoder().encode(a+'.'+b))).toString('base64url');}
const request=value=>new Request('https://editor.example.test/api/state?counts=1',{headers:value?{'Cf-Access-Jwt-Assertion':value}:{}});
const response=keys=>Response.json({keys});
const cause=(code,status)=>error=>{assert.ok(error instanceof AuthError);assert.equal(error.code,code);assert.equal(error.status,status);assert.equal(error.cause,undefined);assert.ok(!JSON.stringify(error).includes('allowed@'));return true;};
test('every JWT and editor failure has a fixed cause, without revealing claims',async()=>{
 const verify=createEditorIdentity({fetchImpl:async()=>response([first.jwk]),clock:()=>start});
 await assert.rejects(verify(request(),env),cause('jwt_missing',401));
 await assert.rejects(verify(request('PRIVATE.COOKIE.JWT'),env),cause('jwt_malformed',403));
 for(const [claims,code,status] of [[{exp:0},'jwt_expired',401],[{iss:'https://other.example'},'jwt_issuer_mismatch',403],[{aud:['other']},'jwt_audience_mismatch',403],[{iat:(start+120000)/1000},'jwt_issued_in_future',403],[{nbf:(start+120000)/1000},'jwt_not_yet_valid',403],[{nbf:'bad'},'jwt_time_invalid',403],[{email:null},'jwt_identity_missing',403],[{email:'other@example.test'},'editor_not_allowed',403]])await assert.rejects(verify(request(await token(first,claims)),env),cause(code,status));
 await assert.rejects(verify(request(await token(first,{}, {alg:'none'})),env),cause('jwt_algorithm_invalid',403));
 await assert.rejects(verify(request(await token(second,{}, {kid:'first'})),env),cause('jwt_signature_invalid',403));
 await assert.rejects(verify(request(await token()),{...env,EDITOR_EMAILS:''}),cause('editor_configuration',500));
 await assert.rejects(verify(request(await token()),{...env,ACCESS_AUD:''}),cause('auth_configuration',500));
});
test('JWKS HTTP/network/timeout/redirect/invalid failures are 503, not editor denial or a reauthentication demand',async()=>{
 for(const [fetchImpl,code,upstream]of [
  [async()=>new Response('PRIVATE',{status:429}),'auth_keys_http',429],
  [async()=>new Response('PRIVATE',{status:503}),'auth_keys_http',503],
  [async()=>{throw new DOMException('PRIVATE','TimeoutError');},'auth_keys_timeout'],
  [async()=>{throw TypeError('PRIVATE');},'auth_keys_network'],
  [async()=>new Response('',{status:302,headers:{Location:'https://private.example'}}),'auth_keys_redirect',302],
  [async()=>new Response('PRIVATE_INVALID_JSON'),'auth_keys_invalid'],
  [async()=>response([]),'auth_keys_invalid'],
  [async()=>response([{...first.jwk,n:'bad'}]),'auth_keys_invalid'],
 ]){
  const verify=createEditorIdentity({fetchImpl,clock:()=>start});await assert.rejects(verify(request(await token()),env),error=>{cause(code,503)(error);assert.equal(error.action,'retry');assert.equal(error.upstreamStatus,upstream);assert.ok(!JSON.stringify(error).includes('PRIVATE'));return true;});
 }
});
test('concurrent cold requests share one complete key fetch; every request still checks expiry, audience and current allowlist',async()=>{
 let calls=0,release;const gate=new Promise(resolve=>release=resolve);
 const verify=createEditorIdentity({clock:()=>start,fetchImpl:async()=>{calls++;await gate;return response([first.jwk]);}});
 const signed=await token();const requests=Array.from({length:16},()=>verify(request(signed),env));release();await Promise.all(requests);assert.equal(calls,1);
 await assert.rejects(verify(request(signed),{...env,EDITOR_EMAILS:'revoked@example.test'}),cause('editor_not_allowed',403));
 await assert.rejects(verify(request(signed),{...env,ACCESS_AUD:'changed'}),cause('jwt_audience_mismatch',403));assert.equal(calls,1);
});
test('unknown kid refreshes fresh cache once for rotation, but forged unknown IDs cannot force repeated downloads',async()=>{
 let calls=0;const verify=createEditorIdentity({clock:()=>start,fetchImpl:async()=>{calls++;return response(calls===1?[first.jwk]:[first.jwk,second.jwk]);}});
 assert.equal(await verify(request(await token()),env),'allowed@example.test');
 assert.equal(await verify(request(await token(second)),env),'allowed@example.test');assert.equal(calls,2);
 for(let i=0;i<4;i++)await assert.rejects(verify(request(await token(first,{}, {kid:'unknown-'+i})),env),cause('jwt_unknown_key',403));assert.equal(calls,2);
});
test('failed cache refresh never accepts expired cached keys and never poisons the next successful retrieval',async()=>{
 let now=start,calls=0;const verify=createEditorIdentity({clock:()=>now,fetchImpl:async()=>{calls++;return calls===2?new Response('PRIVATE',{status:503}):response([first.jwk]);}});
 const signed=await token();await verify(request(signed),env);now+=300001;
 await assert.rejects(verify(request(signed),env),cause('auth_keys_http',503));
 assert.equal(await verify(request(signed),env),'allowed@example.test');assert.equal(calls,3);
 now=start+3600001;await assert.rejects(verify(request(signed),env),cause('jwt_expired',401));
});
test('eight cold isolates with intermittent JWKS failure reproduce the old symptoms without changing identity or permissions',async()=>{
 const signed=await token();const results=[];
 for(let i=1;i<=32;i++){
  const verify=createEditorIdentity({clock:()=>start,fetchImpl:async()=>i%8===0?new Response('PRIVATE',{status:503}):response([first.jwk])});
  try{await verify(request(signed),env);results.push(200);}catch(error){results.push(error.status);assert.equal(error.code,'auth_keys_http');assert.equal(error.action,'retry');}
 }
 assert.deepEqual(results.filter(s=>s!==200),[503,503,503,503]);
});
test('parallel rotations share one refresh; a failed rotation does not invalidate still-fresh known keys',async()=>{
 let calls=0,release;const gate=new Promise(resolve=>release=resolve);
 const verify=createEditorIdentity({clock:()=>start,fetchImpl:async()=>{calls++;if(calls===1)return response([first.jwk]);await gate;return response([first.jwk,second.jwk]);}});
 await verify(request(await token()),env);const rotated=await token(second);const pending=Array.from({length:8},()=>verify(request(rotated),env));
 assert.equal(await verify(request(await token()),env),'allowed@example.test');release();await Promise.all(pending);assert.equal(calls,2);
 const bad=createEditorIdentity({clock:()=>start,fetchImpl:async()=>++calls===3?response([first.jwk]):new Response('PRIVATE',{status:503})});
 await bad(request(await token()),env);await assert.rejects(bad(request(rotated),env),cause('auth_keys_http',503));assert.equal(await bad(request(await token()),env),'allowed@example.test');
});
test('issuer caches stay separate, and a token expiring during a key request never grants access',async()=>{
 const otherEnv={...env,ACCESS_ISSUER:'https://other-issuer.cloudflareaccess.com'};
 const verify=createEditorIdentity({clock:()=>start,fetchImpl:async url=>response(url.startsWith(otherEnv.ACCESS_ISSUER)?[{...second.jwk,kid:'first'}]:[first.jwk])});
 await verify(request(await token()),env);await verify(request(await token(second,{iss:otherEnv.ACCESS_ISSUER},{kid:'first'})),otherEnv);await verify(request(await token()),env);
 let now=start;const expire=createEditorIdentity({clock:()=>now,fetchImpl:async()=>{now+=10000;return response([first.jwk]);}});
 await assert.rejects(expire(request(await token(first,{exp:Math.floor(start/1000)+5})),env),cause('jwt_expired',401));
});
test('identical public key duplicates are harmless; conflicting keys sharing a kid fail closed',async()=>{
 const signed=await token();
 const identical=createEditorIdentity({clock:()=>start,fetchImpl:async()=>response([first.jwk,{...first.jwk}])});await identical(request(signed),env);
 const conflicting=createEditorIdentity({clock:()=>start,fetchImpl:async()=>response([first.jwk,{...second.jwk,kid:first.jwk.kid}])});await assert.rejects(conflicting(request(signed),env),cause('auth_keys_invalid',503));
});
