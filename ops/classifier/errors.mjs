export class ApiError extends Error {
  constructor(status, code) { super(code); this.status=status; this.code=code; }
}
export function diagnostic(route,status,code,requestId) {
  // No actor, URL query, headers, request/response body, raw exception or Wiki source.
  const known=['/api/state','/api/item','/api/history','/api/decision','/internal/import','/internal/pending','/internal/prepare','/internal/ack','/internal/item','/internal/lookup','/internal/custody','/internal/custody-recovery','/internal/custody-status'];
  console.info(JSON.stringify({component:'classifier',route:known.includes(route)?route:'other',status,code,requestId}));
}
