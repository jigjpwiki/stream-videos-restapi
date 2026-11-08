import { replaceSections } from './formatWiki.js';
export const PAGE = 'FrontPage/配信スケジュール';
export function wikiClient(request, env) {
  const base = env.WIKI_API_BASE_URL?.replace(/\/$/, '');
  if (base !== 'https://api.wikiwiki.jp/jigjp' || !env.WIKI_PASSWORD) throw new Error('Expected jigjp Wiki API configuration');
  let token;
  const headers = async () => {
    if (!token) {
      const auth = await request('Wiki auth', `${base}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.WIKI_PASSWORD }) });
      if (typeof auth.token !== 'string' || !auth.token) throw new Error('Invalid Wiki token');
      token = auth.token;
    }
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  const url = `${base}/page/${encodeURIComponent(PAGE)}`;
  return {
    async get() {
      const data = await request('Wiki GET', url, { headers: await headers() });
      if (typeof data.source !== 'string') throw new Error('Invalid Wiki source');
      return data.source;
    },
    async put(source) { await request('Wiki PUT', url, { method: 'PUT', headers: await headers(), body: JSON.stringify({ source }) }); },
  };
}
export async function sync({ wiki, sections, dryRun = true, writeEnabled = false, save }) {
  const before = await wiki.get();
  const after = replaceSections(before, sections);
  // Save preview and recovery source before any write.
  await save(before, after);
  if (before === after) return { changed: false, written: false };
  if (dryRun || !writeEnabled) return { changed: true, written: false };
  if (await wiki.get() !== before) throw new Error('Wiki changed concurrently; update aborted');
  await wiki.put(after);
  if (await wiki.get() !== after) throw new Error('Wiki post-write verification failed; inspect backup');
  return { changed: true, written: true };
}
