export class ApiError extends Error {
  constructor(status, code) { super(code); this.status=status; this.code=code; }
}
export function diagnostic(route,status,code,requestId,metrics={}) {
  // No actor, URL query, headers, request/response body, raw exception or Wiki source.
  const known=['/api/state','/api/item','/api/history','/api/decision','/internal/import','/internal/pending','/internal/prepare','/internal/ack','/internal/item','/internal/lookup','/internal/custody','/internal/custody-recovery','/internal/custody-status'];
  console.info(JSON.stringify({component:'classifier',route:known.includes(route)?route:'other',status,code,requestId,...(['worker','durable_object','auth'].includes(metrics.stage)?{stage:metrics.stage}:{}),...(Number.isInteger(metrics.upstreamStatus)&&metrics.upstreamStatus>=100&&metrics.upstreamStatus<=599?{upstreamStatus:metrics.upstreamStatus}:{}),...(Number.isFinite(metrics.elapsedMs)?{elapsedMs:Math.max(0,Math.round(metrics.elapsedMs))}:{})}));
}
