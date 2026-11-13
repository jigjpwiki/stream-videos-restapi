import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, classify } from '../../src/schedule/normalize.js';
import { verify } from '../../src/schedule/verify.js';
import { formatRows } from '../../src/schedule/formatWiki.js';
import { run } from '../../src/schedule/index.js';
const fixture = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url)));
const scheduled = '2026-11-09T02:00:00+09:00';
const row = { ...fixture.youtube[1], date: scheduled, url: 'https://www.youtube.com/watch?v=cciBBtG7AOo' };
const env = { YOUTUBE_API_KEY: 'MOCK_KEY', WIKI_WRITE_ENABLED: 'true', DRY_RUN: 'false' };
const reservation = () => ({
  id: 'cciBBtG7AOo', snippet: { channelId: row.youtubeid, liveBroadcastContent: 'upcoming' },
  liveStreamingDetails: { scheduledStartTime: scheduled }, contentDetails: { duration: 'P0D' },
});
async function sectionsAt(time, items = [reservation()]) {
  const now = new Date(time);
  const records = await verify(normalize([row], 'youtube'), { env, now, request: async () => ({ items }) });
  return classify(records, now);
}
for (const [time, count] of [['01:59', 1], ['02:00', 1], ['02:05', 0], ['03:30', 0]]) {
  test(`API upcoming at ${time}: elapsed reservation excluded without pretending it is live`, async () => {
    const sections = await sectionsAt(`2026-11-09T${time}:00+09:00`);
    assert.equal(sections.live.length, 0);
    assert.equal(sections.upcoming.length, count);
    const source = formatRows(sections.upcoming, '');
    assert.ok(!source.includes('[開始待ち]'));
    if(count)assert.ok(source.includes('02時00分～'));
  });
}
test('verified actual start moves reservation to live at 02:10 without waiting label', async () => {
  const item = reservation();
  item.snippet.liveBroadcastContent = 'live';
  item.liveStreamingDetails.actualStartTime = '2026-11-09T02:10:00+09:00';
  const sections = await sectionsAt('2026-11-09T02:11:00+09:00', [item]);
  assert.equal(sections.upcoming.length, 0);
  assert.equal(sections.live.length, 1);
  const source = formatRows(sections.live, '');
  assert.ok(source.includes('02時10分～'));
  assert.ok(!source.includes('[開始待ち]'));
});
for (const state of ['ended', 'cancelled', 'missing']) {
  test(`confirmed ${state} stream disappears from both sections`, async () => {
    const item = reservation();
    if (state === 'ended') item.liveStreamingDetails.actualEndTime = '2026-11-09T03:00:00+09:00';
    if (state === 'cancelled') item.snippet.liveBroadcastContent = 'none';
    assert.deepEqual(await sectionsAt('2026-11-09T03:30:00+09:00', state === 'missing' ? [] : [item]), { live: [], upcoming: [] });
  });
}
test('API postponement to 04:00 replaces old time and clears waiting at 03:30', async () => {
  const item = reservation();
  item.liveStreamingDetails.scheduledStartTime = '2026-11-09T04:00:00+09:00';
  const sections = await sectionsAt('2026-11-09T03:30:00+09:00', [item]);
  assert.equal(sections.upcoming.length, 1);
  const source = formatRows(sections.upcoming, '');
  assert.ok(source.includes('04時00分～'));
  assert.ok(!source.includes('[開始待ち]'));
});
test('JST rollover hides previous-day reservations but retains previous-day verified live', async () => {
  assert.deepEqual(await sectionsAt('2026-11-09T15:00:00Z'), { live: [], upcoming: [] });
  const item = reservation();
  item.snippet.liveBroadcastContent = 'live';
  item.liveStreamingDetails.actualStartTime = '2026-11-09T02:10:00+09:00';
  const sections = await sectionsAt('2026-11-10T01:00:00+09:00', [item]);
  assert.equal(sections.live.length, 1);
  assert.equal(sections.upcoming.length, 0);
});
test('future rows retain time/menu/ID sorting, ten-row limit and safe compact Wiki', () => {
  const now = new Date('2026-11-09T03:30:00+09:00');
  const records = Array.from({ length: 12 }, (_, i) => ({
    ...normalize([row], 'youtube')[0], date:'2026-11-09T04:00:00+09:00', id: String(i).padStart(11, '0'), identity: `channel${i}`,
    name: '名前]]\n#evil &ref(x);',
  }));
  const config = { 'youtube:channel11': { menuOrder: 0, facePage: '真昼ねる/face.png' } };
  const sections = classify(records.toReversed(), now, config);
  assert.equal(sections.upcoming.length, 10);
  assert.equal(sections.upcoming[0].identity, 'channel11');
  assert.equal(sections.upcoming[1].id, records[0].id);
  assert.ok(sections.upcoming.every(r => !r.waitingForStart));
  const source = formatRows(sections.upcoming, '');
  assert.equal(source.split('\n').length, 10);
  assert.ok(!source.includes('[開始待ち]'));
  assert.ok(source.includes('&ref(真昼ねる/face.png,nolink,25x25);'));
  assert.ok(!source.includes('#evil'));
  const earlier = { ...records[0], id: 'earlier', date: '2026-11-09T03:45:00+09:00' };
  assert.equal(classify([...records, earlier], now, config).upcoming[0].id, 'earlier');
});
test('dry-run pipeline excludes elapsed reservation; malformed API aborts before Wiki even with writes enabled', async () => {
  const output = await mkdtemp(join(tmpdir(), 'schedule-waiting-'));
  try {
    const demo = { ...fixture, youtube: [row], twitch: [] };
    const now = new Date('2026-11-09T03:30:00+09:00');
    const report = await run({ fixture: demo, env, now, output, fetchImpl: async () => new Response(JSON.stringify({ items: [reservation()] })) });
    assert.equal(report.written, false);
    assert.equal(report.live, 0);
    assert.equal(report.upcoming, 0);
    assert.ok(!(await readFile(join(output, 'preview.wiki'), 'utf8')).includes('02時00分～'));
    let wikiRequests = 0;
    await assert.rejects(run({ env, now, output, fetchImpl: async url => {
      const u = new URL(url);
      if (u.hostname === 'api.wikiwiki.jp') wikiRequests++;
      return new Response(JSON.stringify(u.pathname.endsWith('/youtube.json') ? [row] : u.pathname.endsWith('/twitch.json') ? [] : {}));
    } }));
    assert.equal(wikiRequests, 0);
    await assert.rejects(verify(normalize([row], 'youtube'), { env, now, request: async () => { throw new Error('API unavailable'); } }));
  } finally { await rm(output, { recursive: true, force: true }); }
});
