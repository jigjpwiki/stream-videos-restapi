// Fixed endpoints only. Never retain remote bodies, URLs, credentials or raw causes.
export class HttpRequestError extends Error {
  constructor(label, code, status) {
    super(`${label} failed`);
    this.name = 'HttpRequestError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
function transportCode(error) {
  return ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error';
}
// Only our typed, fixed codes and numeric statuses may enter reports/logs.
export function requestErrorDetails(error) {
  const codes = ['http_error', 'page_not_found', 'timeout', 'network_error', 'invalid_response'];
  if (!(error instanceof HttpRequestError) || !codes.includes(error.code)) return { reason: 'operation_failed' };
  return { reason: error.code, ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) };
}
export function httpClient(fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  return async function request(label, url, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new HttpRequestError(label, 'http_error', response.status);
        if (options.method === 'PUT') return;
        try { return await response.json(); }
        catch (error) {
          throw new HttpRequestError(label, transportCode(error) === 'timeout' ? 'timeout' : 'invalid_response', response.status);
        }
      } catch (error) {
        const safeError = error instanceof HttpRequestError ? error : new HttpRequestError(label, transportCode(error));
        // Preserve the existing maximum of 3 attempts / 1s, 2s backoff for non-PUT.
        // A PUT may have succeeded even if its response was lost: never retry it.
        if (options.method === 'PUT' || attempt === 2) throw safeError;
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
