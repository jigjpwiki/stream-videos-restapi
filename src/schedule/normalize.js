import { timestamp } from './http.js';
export const day = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(date));
export function normalize(data, platform, stats = {}) {
  if (!Array.isArray(data)) throw new Error(`Invalid ${platform} JSON array`);
  const records = new Map();
  const skip = reason => { stats[reason] = (stats[reason] || 0) + 1; };
  for (const row of data) {
    if (!row || typeof row !== 'object' || typeof row.status !== 'string') throw new Error(`Invalid ${platform} record`);
    if (row.status === 'archive' || row.type === 'video') { skip('archiveOrVideo'); continue; }
    if (!['live', 'upcoming'].includes(row.status) || row.type !== 'stream') { skip('notStream'); continue; }
    if (typeof row.name !== 'string' || typeof row.url !== 'string') throw new Error(`Invalid ${platform} fields`);
    if (!timestamp(row.date)) { skip('invalidDate'); continue; }
    let url;
    try { url = new URL(row.url); } catch { skip('invalidURL'); continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) { skip('invalidURL'); continue; }
    let id, identity, canonical;
    if (platform === 'youtube') {
      if (!['youtube.com', 'www.youtube.com', 'youtu.be'].includes(url.hostname)) { skip('invalidURL'); continue; }
      id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/live\/([\w-]+)$/.exec(url.pathname)?.[1];
      identity = row.youtubeid;
      if (!/^[\w-]{11}$/.test(id || '') || !/^UC[\w-]{22}$/.test(identity || '')) { skip('invalidIdentity'); continue; }
      canonical = `https://www.youtube.com/watch?v=${id}`;
    } else {
      identity = typeof row.twitchid === 'string' ? row.twitchid.toLowerCase() : '';
      if (!['twitch.tv', 'www.twitch.tv'].includes(url.hostname) || !/^[a-z0-9_]{1,25}$/.test(identity) || url.pathname.replace(/\/$/, '').toLowerCase() !== `/${identity}`) { skip('invalidURL'); continue; }
      id = identity; canonical = `https://www.twitch.tv/${identity}`;
    }
    const item = { platform, id, identity, name: row.name, status: row.status, date: row.date, url: canonical };
    if (records.has(id)) {
      if (records.get(id).identity !== identity) throw new Error('Conflicting stream identity');
      skip('duplicate'); continue;
    }
    records.set(id, item);
  }
  return [...records.values()];
}
export function classify(records, now, config = {}) {
  const live = [], upcoming = [];
  for (const row of records) {
    const person = config[`${row.platform}:${row.identity}`];
    const item = { ...row, name: person?.displayName || row.name, facePage: person?.facePage, menuOrder: person?.menuOrder ?? Number.MAX_SAFE_INTEGER };
    if (row.status === 'live') live.push(item);
    else if (row.status === 'upcoming' && day(row.date) === day(now)) {
      // YouTube status has been rechecked by verify(): lateness alone is not an end/cancellation.
      const waitingForStart = row.platform === 'youtube' && Date.parse(row.date) <= +now;
      if (waitingForStart || Date.parse(row.date) > +now) upcoming.push({ ...item, waitingForStart });
    }
  }
  const sorted = rows => rows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.menuOrder - b.menuOrder || `${a.platform}:${a.id}`.localeCompare(`${b.platform}:${b.id}`, 'en')).slice(0, 10);
  return { live: sorted(live), upcoming: sorted(upcoming) };
}
