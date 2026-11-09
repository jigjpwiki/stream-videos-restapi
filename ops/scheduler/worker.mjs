const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const active = run => run.status !== 'completed';
const periodic = run => run.event === 'schedule' || (run.event === 'workflow_dispatch' && run.display_title?.startsWith('[periodic]'));

export async function github(env, path, options = {}) {
  let response;
  try { response = await fetch(`https://api.github.com/repos/${env.REPOSITORY}/actions/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'periodic-actions-scheduler', ...options.headers },
    signal: AbortSignal.timeout(3000),
  }); } catch { throw new Error('GitHub transport failed'); }
  // Never log the token or upstream response bodies. Fail closed; no immediate retries.
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  if (Number(response.headers.get('x-ratelimit-remaining') ?? 5000) < 100) throw new Error('GitHub quota reserve reached');
  return response.status === 204 ? null : response.json();
}

export class Scheduler {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    // A single named Durable Object serializes health checks and cron ticks,
    // including requests that yield during GitHub network calls.
    return this.state.blockConcurrencyWhile(async () => {
      try { return await this.handle(request); }
      catch (error) {
        const failure = { checked_at: new Date().toISOString(), error: error.message };
        await this.state.storage.put('error', failure);
        console.error(JSON.stringify(failure));
        return json(failure, 503);
      }
    });
  }
  async handle(request) {
    const env = this.env;
    if (env.ENABLED !== 'true') return json({ enabled: false }, 503);
    if (!env.GITHUB_TOKEN || !env.HEALTH_TOKEN) throw new Error('Required secrets missing');
    const interval = Number(env.INTERVAL_MINUTES) * 60000;
    if (![600000, 900000].includes(interval)) throw new Error('Invalid interval');
    const now = Date.now();
    // Allow up to one minute of scheduler/network jitter at the next slot.
    const cooldown = interval - 60000;
    const endpoint = `workflows/${encodeURIComponent(env.WORKFLOW)}/runs?branch=main&per_page=100`;
    const { workflow_runs: runs } = await github(env, endpoint);
    // Verify an actual collector job succeeded. A workflow whose source gate
    // skipped its collector can otherwise have conclusion=success.
    let success = null;
    for (const run of runs.filter(r => periodic(r) && r.conclusion === 'success').slice(0, 5)) {
      const { jobs } = await github(env, `runs/${run.id}/jobs?per_page=100`);
      const job = jobs.find(j => j.name === env.SUCCESS_JOB && j.conclusion === 'success');
      if (job) { success = { run_id: run.id, url: run.html_url, completed_at: job.completed_at }; break; }
    }
    if (success) await this.state.storage.put('success', success);
    else success = await this.state.storage.get('success') ?? null;
    const lastTick = await this.state.storage.get('tick');
    const report = {
      enabled: true, checked_at: new Date(now).toISOString(), last_success: success,
      last_tick: lastTick ?? null, last_error: await this.state.storage.get('error') ?? null,
      stale: !success || now - Date.parse(success.completed_at) > interval * 3,
    };
    if (new URL(request.url).pathname === '/health') {
      const tickStale = !lastTick || now - Date.parse(lastTick) > interval * 3;
      return json({ ...report, tick_stale: tickStale }, report.stale || tickStale ? 503 : 200);
    }
    await this.state.storage.put('tick', report.checked_at);
    const slot = Math.floor(now / interval);
    const previous = await this.state.storage.get('dispatch');
    // Treat any writer (manual/push/native/external) as work for this interval.
    // GitHub's workflow concurrency is the final protection against races with
    // a manual/native run starting after this read.
    const busy = runs.some(active);
    const recent = runs.some(r => r.event !== 'pull_request' && now - Date.parse(r.created_at) < cooldown);
    if (busy || recent || (previous && (previous.slot >= slot || now - previous.at < cooldown))) {
      console.log(JSON.stringify({ ...report, action: 'suppressed', busy, recent }));
      return json({ action: 'suppressed' });
    }
    // Persist BEFORE POST. A timeout/ambiguous response consumes this slot;
    // automatically retrying a POST could dispatch duplicate work.
    await this.state.storage.put('dispatch', { slot, at: now, state: 'attempted' });
    await github(env, `workflows/${encodeURIComponent(env.WORKFLOW)}/dispatches`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { periodic: true } }),
    });
    await this.state.storage.put('dispatch', { slot, at: now, state: 'accepted' });
    console.log(JSON.stringify({ ...report, action: 'dispatched' }));
    return json({ action: 'dispatched' });
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const response = await env.SCHEDULER.get(env.SCHEDULER.idFromName('singleton')).fetch('https://scheduler/tick', { method: 'POST' });
      if (!response.ok) throw new Error(`Scheduler tick failed: ${response.status}`);
    })());
  },
  async fetch(request, env) {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/health') return new Response('Not found', { status: 404 });
    if (!env.HEALTH_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.HEALTH_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    return env.SCHEDULER.get(env.SCHEDULER.idFromName('singleton')).fetch('https://scheduler/health');
  },
};
