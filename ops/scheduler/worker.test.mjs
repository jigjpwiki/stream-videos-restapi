import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Scheduler } from './worker.mjs';
const env = { ENABLED: 'true', GITHUB_TOKEN: 'test', HEALTH_TOKEN: 'health', REPOSITORY: 'owner/repo', WORKFLOW: 'job.yml', INTERVAL_MINUTES: '15', SUCCESS_JOB: 'sync' };
function setup(runs = [], jobs = []) {
  const data = new Map(); const calls = [];
  const state = { storage: { get: async k => data.get(k), put: async (k, v) => data.set(k, v) }, blockConcurrencyWhile: fn => fn() };
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, ...opts });
    return opts.method === 'POST' ? new Response(null, { status: 204 }) : Response.json(url.includes('/jobs?') ? { jobs } : { workflow_runs: runs });
  };
  return { scheduler: new Scheduler(state, env), calls, data };
}
const tick = s => s.fetch(new Request('https://scheduler/tick', { method: 'POST' }));
test('dispatch uses periodic semantics; durable cooldown rejects duplicate and adjacent-slot retry', async () => {
  const { scheduler, calls, data } = setup();
  assert.equal((await tick(scheduler)).status, 200);
  assert.deepEqual(JSON.parse(calls.find(c => c.method === 'POST').body), { ref: 'main', inputs: { periodic: true } });
  const dispatch = data.get('dispatch');
  data.set('dispatch', { ...dispatch, slot: dispatch.slot - 1 });
  await tick(scheduler);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});
test('busy or recent manual/native writers suppress dispatch', async () => {
  for (const run of [{ status: 'queued' }, { status: 'in_progress' }, { status: 'completed', event: 'workflow_dispatch', created_at: new Date().toISOString() }]) {
    const { scheduler, calls } = setup([run]); await tick(scheduler);
    assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  }
});
test('failed and ambiguous POST is not retried within the interval', async () => {
  const { scheduler, calls } = setup();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (opts.method === 'POST') throw new Error('timeout'); return original(url, opts); };
  assert.equal((await tick(scheduler)).status, 503);
  globalThis.fetch = original;
  await tick(scheduler);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});
test('health validates collector success rather than a skipped successful workflow', async () => {
  const runs = [{ id: 1, event: 'schedule', status: 'completed', conclusion: 'success' }];
  let fixture = setup(runs, [{ name: 'sync', conclusion: 'skipped' }]);
  fixture.data.set('tick', new Date().toISOString());
  assert.equal((await fixture.scheduler.fetch(new Request('https://scheduler/health'))).status, 503);
  fixture = setup(runs, [{ name: 'sync', conclusion: 'success', completed_at: new Date().toISOString() }]);
  fixture.data.set('tick', new Date().toISOString());
  const response = await fixture.scheduler.fetch(new Request('https://scheduler/health'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).last_success.run_id, 1);
  fixture.data.set('tick', new Date(Date.now() - 3600000).toISOString());
  assert.equal((await fixture.scheduler.fetch(new Request('https://scheduler/health'))).status, 503);
});
test('GitHub errors and low quota fail closed', async () => {
  for (const response of [new Response('', { status: 403 }), Response.json({ workflow_runs: [] }, { headers: { 'x-ratelimit-remaining': '99' } })]) {
    const { scheduler, data } = setup(); globalThis.fetch = async () => response;
    assert.equal((await tick(scheduler)).status, 503);
    assert.equal(data.has('dispatch'), false);
  }
});
test('disabled worker and unauthenticated public routes cannot dispatch', async () => {
  const { scheduler, calls } = setup(); scheduler.env = { ...env, ENABLED: 'false' };
  assert.equal((await tick(scheduler)).status, 503); assert.equal(calls.length, 0);
  assert.equal((await worker.fetch(new Request('https://worker/health'), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://worker/tick', { method: 'POST' }), env)).status, 404);
});

test('next-slot jitter does not halve the intended frequency', async () => {
  const now = Date.now(); const interval = 900000;
  const { scheduler, calls, data } = setup([{ status: 'completed', event: 'workflow_dispatch', created_at: new Date(now - interval + 10000).toISOString() }]);
  data.set('dispatch', { slot: Math.floor(now / interval) - 1, at: now - interval + 10000 });
  await tick(scheduler);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});
