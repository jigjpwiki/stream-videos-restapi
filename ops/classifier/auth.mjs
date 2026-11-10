// Verify every request. Cache public keys only, never JWTs, emails or authorizations.
export class AuthError extends Error {
  constructor(status,code,action='contact_admin',upstreamStatus) {
    super(code);this.name='AuthError';this.status=status;this.code=code;this.action=action;
    if(Number.isInteger(upstreamStatus))this.upstreamStatus=upstreamStatus;
  }
}
function fail(code,status=403,action='contact_admin'){throw new AuthError(status,code,action);}
function bytes(part){
 if(typeof part!=='string'||!/^[A-Za-z0-9_-]+$/.test(part))fail('jwt_malformed');
 try{return Uint8Array.from(atob(part.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}catch{fail('jwt_malformed');}
}
function decode(part){try{const data=JSON.parse(new TextDecoder().decode(bytes(part)));if(!data||typeof data!=='object'||Array.isArray(data))fail('jwt_malformed');return data;}catch{fail('jwt_malformed');}}
function checkClaims(claims,env,now){
 if(claims.iss!==env.ACCESS_ISSUER)fail('jwt_issuer_mismatch');
 if(!Array.isArray(claims.aud)||!claims.aud.includes(env.ACCESS_AUD))fail('jwt_audience_mismatch');
 if(!Number.isFinite(claims.exp)||!Number.isFinite(claims.iat)||(claims.nbf!==undefined&&!Number.isFinite(claims.nbf)))fail('jwt_time_invalid');
 if(claims.exp*1000<=now)fail('jwt_expired',401,'reauthenticate');
 if(claims.iat*1000>now+60000)fail('jwt_issued_in_future');
 if(claims.nbf!==undefined&&claims.nbf*1000>now)fail('jwt_not_yet_valid');
 if(typeof claims.email!=='string'||!claims.email)fail('jwt_identity_missing');
}
export function createEditorIdentity({fetchImpl:defaultFetch,clock=()=>Date.now(),cacheMs=300000,rotationCooldownMs=30000}={}){
 const caches=new Map();
 async function load(state,issuer,fetchImpl,now){
  if(state.flight)return state.flight;
  const operation=(async()=>{
   let response;
   try{response=await fetchImpl(`${issuer}/cdn-cgi/access/certs`,{redirect:'manual',signal:AbortSignal.timeout(5000)});}
   catch(error){throw new AuthError(503,['TimeoutError','AbortError'].includes(error?.name)?'auth_keys_timeout':'auth_keys_network','retry');}
   if(response.status>=300&&response.status<400)throw new AuthError(503,'auth_keys_redirect','retry',response.status);
   if(!response.ok)throw new AuthError(503,'auth_keys_http','retry',response.status);
   let data;
   try{data=await response.json();}catch(error){throw new AuthError(503,['TimeoutError','AbortError'].includes(error?.name)?'auth_keys_timeout':'auth_keys_invalid','retry');}
   if(!Array.isArray(data?.keys)||!data.keys.length||data.keys.length>32)throw new AuthError(503,'auth_keys_invalid','retry');
   const keys=new Map(),seen=new Map();
   for(const jwk of data.keys){
    if(jwk.kty!=='RSA')continue;
    if(typeof jwk.kid!=='string'||!jwk.kid||typeof jwk.n!=='string'||typeof jwk.e!=='string'||(jwk.alg&&jwk.alg!=='RS256')||(jwk.use&&jwk.use!=='sig'))throw new AuthError(503,'auth_keys_invalid','retry');
    const material=jwk.n+'.'+jwk.e;
    if(seen.has(jwk.kid)){if(seen.get(jwk.kid)!==material)throw new AuthError(503,'auth_keys_invalid','retry');continue;}
    seen.set(jwk.kid,material);
    try{const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);if(key.algorithm.modulusLength<2048)throw Error();keys.set(jwk.kid,key);}
    catch{throw new AuthError(503,'auth_keys_invalid','retry');}
   }
   if(!keys.size)throw new AuthError(503,'auth_keys_invalid','retry');
   // Publish a complete, validated set atomically. Never cache partial or failed responses.
   state.keys=keys;state.until=now+cacheMs;return keys;
  })();
  state.flight=operation;
  try{return await operation;}finally{if(state.flight===operation)state.flight=null;}
 }
 return async function editorIdentity(request,env,fetchImpl=defaultFetch??fetch,now){
  const current=now??clock(),issuer=env.ACCESS_ISSUER;
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer??'')||typeof env.ACCESS_AUD!=='string'||!env.ACCESS_AUD)fail('auth_configuration',500);
  if(typeof env.EDITOR_EMAILS!=='string'||!env.EDITOR_EMAILS.split(',').some(s=>s.trim()))fail('editor_configuration',500);
  const raw=request.headers.get('Cf-Access-Jwt-Assertion');
  if(!raw)fail('jwt_missing',401,'reauthenticate');
  if(raw.length>16000)fail('jwt_malformed');
  const parts=raw.split('.');if(parts.length!==3)fail('jwt_malformed');
  const head=decode(parts[0]),claims=decode(parts[1]);
  if(head.alg!=='RS256'||typeof head.kid!=='string'||!head.kid)fail('jwt_algorithm_invalid');
  checkClaims(claims,env,current);
  let state=caches.get(issuer);
  if(!state){if(caches.size>=4)caches.delete(caches.keys().next().value);state={keys:null,until:0,flight:null,lastRotation:-Infinity};caches.set(issuer,state);}
  const fresh=state.keys&&current<state.until;
  let keys=fresh?state.keys:await load(state,issuer,fetchImpl,current);
  let key=keys.get(head.kid);
  if(!key&&fresh){
   if(state.flight){keys=await state.flight;}
   else if(current-state.lastRotation>=rotationCooldownMs){state.lastRotation=current;keys=await load(state,issuer,fetchImpl,current);}
   key=keys.get(head.kid);
  }
  if(!key)fail('jwt_unknown_key');
  let verified=false;
  try{verified=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,bytes(parts[2]),new TextEncoder().encode(`${parts[0]}.${parts[1]}`));}
  catch(error){if(error instanceof AuthError)throw error;fail('jwt_signature_invalid');}
  if(!verified)fail('jwt_signature_invalid');
  checkClaims(claims,env,now??clock());
  const email=claims.email.toLowerCase();
  if(!env.EDITOR_EMAILS.split(',').map(s=>s.trim().toLowerCase()).includes(email))fail('editor_not_allowed');
  return email;
 };
}
export const editorIdentity=createEditorIdentity();
export async function syncAuthorized(request, env) {
  const value=request.headers.get('Authorization')??'';
  if(!env.SYNC_TOKEN || env.SYNC_TOKEN.length<32)return false;
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`Bearer ${env.SYNC_TOKEN}`)));
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
