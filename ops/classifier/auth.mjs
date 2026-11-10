// Cloudflare Access is configured for this Worker hostname. Verify signed identity,
// including on workers.dev (or disable workers.dev); never trust the email header alone.
const decode = part => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));
const bytes = part => Uint8Array.from(atob(part.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
let cached;
export async function editorIdentity(request, env, fetchImpl = fetch, now = Date.now()) {
  const issuer=env.ACCESS_ISSUER;
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer??'') || !env.ACCESS_AUD)throw Error('Access configuration missing');
  const raw=request.headers.get('Cf-Access-Jwt-Assertion');
  if(!raw || raw.length>16000)throw Error('Access identity required');
  const parts=raw.split('.');if(parts.length!==3)throw Error('Invalid JWT');
  const head=decode(parts[0]), claims=decode(parts[1]);
  if(head.alg!=='RS256'||typeof head.kid!=='string')throw Error('Invalid JWT algorithm');
  if(!cached || cached.issuer!==issuer || cached.until<now) {
    const res = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error('Unexpected redirect when fetching Access keys');
    }
    if(!res.ok)throw Error('Access keys unavailable');
    const data=await res.json();if(!Array.isArray(data.keys))throw Error('Invalid keys');
    cached={issuer,keys:data.keys,until:now+300000};
  }
  const jwk=cached.keys.find(key=>key.kid===head.kid && key.kty==='RSA');
  if(!jwk)throw Error('Unknown Access key');
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,bytes(parts[2]),new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))throw Error('Invalid JWT signature');
  if(claims.iss!==issuer || !Array.isArray(claims.aud) || !claims.aud.includes(env.ACCESS_AUD) || !Number.isFinite(claims.exp) || claims.exp*1000<=now || !Number.isFinite(claims.iat) || claims.iat*1000>now+60000 || (claims.nbf && claims.nbf*1000>now) || typeof claims.email!=='string')throw Error('Invalid Access claims');
  const allowed=(env.EDITOR_EMAILS??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if(!allowed.includes(claims.email.toLowerCase()))throw Error('Editor not allowed');
  return claims.email.toLowerCase();
}
export async function syncAuthorized(request, env) {
  const value=request.headers.get('Authorization')??'';
  if(!env.SYNC_TOKEN || env.SYNC_TOKEN.length<32)return false;
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`Bearer ${env.SYNC_TOKEN}`)));
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
