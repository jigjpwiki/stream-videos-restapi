import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wikiHttpClient } from '../services/wikiHttp.js';
import { httpClient } from './http.js';
import { normalize, classify } from './normalize.js';
import { verify } from './verify.js';
import { sync, wikiClient } from './sync.js';

export async function run({ env = process.env, fetchImpl = fetch, now = new Date(), fixture, output = 'work/schedule' } = {}) {
  const report = { processedAt: now.toISOString(), sources: {}, skipped: {} };
  const generalTransport = httpClient(fetchImpl), wikiTransport = wikiHttpClient(fetchImpl);
  const transport = (label,...args) => (label.startsWith('Wiki ')?wikiTransport:generalTransport)(label,...args);
  report.apis = {};
  const request = async (label, url, options) => {
    try {
      const data = await transport(label, url, options);
      report.apis[label] = 'ok';
      return data;
    } catch {
      console.error(`${label}: failed`);
      throw new Error('API operation failed');
    }
  };
  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  let records = [];
  for (const platform of ['youtube', 'twitch']) {
    const data = fixture ? fixture[platform] : await request(`Jigdule ${platform}`, `https://www.jigdule.jp/data/${platform}.json`);
    report.sources[platform] = data?.length;
    records.push(...normalize(data, platform, report.skipped));
  }
  const verified = await verify(records, { request, env, now });
  const sections = classify(verified, now, config);
  Object.assign(report, { live: sections.live.length, upcoming: sections.upcoming.length, verified: verified.length });
  const wiki = fixture ? { get: async () => fixture.source, put: async () => { throw new Error('Fixture write prohibited'); } } : wikiClient(request, env);
  await mkdir(output, { recursive: true });
  const result = await sync({ wiki, sections, dryRun: !!fixture || env.DRY_RUN !== 'false', writeEnabled: env.WIKI_WRITE_ENABLED === 'true', save: async (before, after) => {
    await writeFile(resolve(output, 'before.wiki'), before);
    await writeFile(resolve(output, 'preview.wiki'), after);
    const diff = spawnSync('git', ['diff', '--no-index', '--', resolve(output, 'before.wiki'), resolve(output, 'preview.wiki')], { encoding: 'utf8' });
    if (![0, 1].includes(diff.status)) throw new Error('Preview diff failed');
    await writeFile(resolve(output, 'preview.diff'), diff.stdout);
  } });
  Object.assign(report, result);
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtureAt = process.argv.indexOf('--fixture');
  const outputAt = process.argv.indexOf('--output');
  try {
    let fixture, fetchImpl;
    if (fixtureAt !== -1) {
      fixture = JSON.parse(await readFile(process.argv[fixtureAt + 1], 'utf8'));
      fetchImpl = async url => {
        const key = new URL(url).hostname;
        const data = fixture.responses[key];
        if (!data) throw new Error('Unexpected fixture endpoint');
        return new Response(JSON.stringify(data), { status: 200 });
      };
    }
    await run({ fixture, fetchImpl, env: fixture ? { YOUTUBE_API_KEY: 'DEMO_KEY', TWITCH_CLIENT_ID: 'DEMO_CLIENT', TWITCH_CLIENT_SECRET: 'DEMO_SECRET' } : process.env, now: fixture ? new Date(fixture.now) : new Date(), output: outputAt !== -1 ? process.argv[outputAt + 1] : undefined });
  } catch {
    // Remote exceptions may contain credentials: log only a fixed message.
    console.error('Schedule sync failed; Wiki update aborted. Check configuration, markers and API availability.');
    process.exitCode = 1;
  }
}
