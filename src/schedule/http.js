// Fixed endpoints only. Never retain remote bodies, URLs, credentials or raw causes.
export class HttpRequestError extends Error {
  constructor(label, code, status, retryAfterMs) {
    super(`${label} failed`);
    this.name = 'HttpRequestError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}
function transportCode(error) {
  return ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error';
}
// Only our typed, fixed codes and numeric statuses may enter reports/logs.
export function requestErrorDetails(error) {
  const codes = ['http_error', 'page_not_found', 'timeout', 'network_error', 'invalid_response', 'rate_limited'];
  if (!(error instanceof HttpRequestError) || !codes.includes(error.code)) return { reason: 'operation_failed' };
  return { reason: error.code, ...(error.writeAttempted === true ? { writeAttempted:true } : {}), ...(error.writeUnverified === true ? { writeUnverified:true } : {}), ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}), ...(['get','conflict_get','put','verify_get','auth'].includes(error.operation) ? { operation: error.operation } : {}), ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) };
}
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+$/.test(value.trim())) { const ms = Number(value) * 1000; return Number.isSafeInteger(ms) && now + ms <= 8640000000000000 ? ms : undefined; }
  if (!/^[A-Za-z]{3}, /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export function httpClient(fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), { maxAttempts = 3 } = {}) {
  return async function request(label, url, options = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new HttpRequestError(label, 'http_error', response.status, response.status === 429 ? retryAfterMs(response.headers.get('retry-after')) : undefined);
        if (options.method === 'PUT') return;
        try { return await response.json(); }
        catch (error) {
          throw new HttpRequestError(label, transportCode(error) === 'timeout' ? 'timeout' : 'invalid_response', response.status);
        }
      } catch (error) {
        const safeError = error instanceof HttpRequestError ? error : new HttpRequestError(label, transportCode(error));
        // Preserve the existing maximum of 3 attempts / 1s, 2s backoff for non-PUT.
        // A PUT may have succeeded even if its response was lost: never retry it.
        if (options.method === 'PUT' || attempt === maxAttempts - 1) throw safeError;
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
