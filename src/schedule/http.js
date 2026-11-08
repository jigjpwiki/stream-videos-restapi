// Fixed endpoints only. Do not expose remote response bodies, URLs or credentials in errors.
export function httpClient(fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  return async function request(label, url, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
          if (options.method !== 'PUT' && (response.status === 429 || response.status >= 500) && attempt < 2) {
            await sleep(1000 * 2 ** attempt); continue;
          }
          throw new Error();
        }
        if (options.method === 'PUT') return;
        return await response.json();
      } catch {
        // A PUT may have succeeded even if its response was lost: never retry it.
        if (options.method === 'PUT' || attempt === 2) throw new Error(`${label} failed`);
        await sleep(1000 * 2 ** attempt);
      }
    }
  };
}
export function arrayField(data, key) {
  if (!Array.isArray(data?.[key])) throw new Error(`Invalid API ${key} array`);
  return data[key];
}
export function timestamp(value) {
  if (typeof value !== 'string') return false;
  const [year, month, date] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || date < 1 || date > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}
