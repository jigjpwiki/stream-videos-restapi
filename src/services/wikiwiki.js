import { httpClient } from '../schedule/http.js';

// Never expose credentials/remote bodies in errors. No retries for ambiguous PUTs.
export function videoWikiClient(env = process.env, fetchImpl = fetch) {
  const base = env.WIKI_API_BASE_URL?.replace(/\/$/, '');
  if (base !== 'https://api.wikiwiki.jp/jigjp' || !env.WIKI_PASSWORD) throw new Error('Expected jigjp Wiki configuration');
  const request = httpClient(fetchImpl);
  let token;
  const headers = async () => {
    if (!token) {
      const auth = await request('Wiki auth', `${base}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.WIKI_PASSWORD }) });
      if (typeof auth.token !== 'string' || !auth.token) throw new Error('Invalid Wiki token');
      token = auth.token;
    }
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  return {
    async get(page) {
      const data = await request('Wiki GET', `${base}/page/${encodeURIComponent(page)}`, { headers: await headers() });
      if (typeof data.source !== 'string') throw new Error('Invalid Wiki source');
      return data.source;
    },
    async put(page, source) {
      if (env.DRY_RUN !== 'false' || env.VIDEO_WIKI_WRITE_ENABLED !== 'true') throw new Error('Video Wiki write disabled');
      await request('Wiki PUT', `${base}/page/${encodeURIComponent(page)}`, { method: 'PUT', headers: await headers(), body: JSON.stringify({ source }) });
    },
  };
}

// Shared by ingestion and manual classification. Save recovery material before PUT.
export async function guardedEdit({ wiki, page, transform, save, dryRun = true, writeEnabled = false }) {
  const before = await wiki.get(page);
  const after = await transform(before);
  if (typeof after !== 'string') throw new Error('Invalid transformed source');
  await save(before, after);
  if (after === before) return { changed: false, written: false };
  if (dryRun || !writeEnabled) return { changed: true, written: false };
  if (await wiki.get(page) !== before) throw new Error('Wiki conflict; retry next run');
  await wiki.put(page, after);
  if (await wiki.get(page) !== after) throw new Error('Wiki verification failed; inspect recovery preview');
  return { changed: true, written: true };
}
