import { httpClient, HttpRequestError } from '../schedule/http.js';

export class WikiPageNotFoundError extends HttpRequestError {
  constructor() {
    super('Wiki GET', 'page_not_found', 404);
    this.name = 'WikiPageNotFoundError';
  }
}

// Never expose credentials/remote bodies in errors. No retries for ambiguous PUTs.
export function videoWikiClient(env = process.env, fetchImpl = fetch) {
  const base = env.WIKI_API_BASE_URL?.replace(/\/$/, '');
  if (base !== 'https://api.wikiwiki.jp/jigjp' || !env.WIKI_PASSWORD) throw new Error('Expected jigjp Wiki configuration');
  const request = httpClient(fetchImpl);
  let token;
  const headers = async () => {
    if (!token) {
      const auth = await request('Wiki auth', `${base}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.WIKI_PASSWORD }) });
      if (typeof auth?.token !== 'string' || !auth.token) throw new HttpRequestError('Wiki auth', 'invalid_response');
      token = auth.token;
    }
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  };
  return {
    async get(page) {
      // Authentication failures (including auth 404) are never page-not-found.
      const pageHeaders = await headers();
      let data;
      try {
        data = await request('Wiki GET', `${base}/page/${encodeURIComponent(page)}`, { headers: pageHeaders });
      } catch (error) {
        if (error instanceof HttpRequestError && error.code === 'http_error' && error.status === 404) throw new WikiPageNotFoundError();
        throw error;
      }
      if (typeof data?.source !== 'string') throw new HttpRequestError('Wiki GET', 'invalid_response');
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
