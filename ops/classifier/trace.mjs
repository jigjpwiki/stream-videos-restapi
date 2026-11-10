export function traceId(value) {
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value??'')?value:crypto.randomUUID();
}
export function tracedResponse(response,requestId) {
  const headers=new Headers(response.headers);
  headers.set('X-Request-Id',requestId);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
