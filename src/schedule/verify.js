import { arrayField, timestamp } from './http.js';
export async function verify(records, { request, env, now }) {
  const result = [];
  // Recheck all retained reservations, including postponed future streams.
  const yt = records.filter(r => r.platform === 'youtube');
  if (yt.length && !env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY required');
  for (let i = 0; i < yt.length; i += 50) {
    const batch = yt.slice(i, i + 50);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.search = new URLSearchParams({ part: 'snippet,liveStreamingDetails,contentDetails', id: batch.map(r => r.id).join(','), key: env.YOUTUBE_API_KEY });
    const items = arrayField(await request('YouTube videos.list', url), 'items');
    for (const item of items) {
      const row = batch.find(r => r.id === item.id);
      if (!row || typeof item.snippet?.liveBroadcastContent !== 'string' || item.snippet.channelId !== row.identity) throw new Error('Invalid YouTube verification');
      const details = item.liveStreamingDetails;
      if (details?.actualEndTime || item.snippet.liveBroadcastContent === 'none') continue;
      if (!details) throw new Error('Missing YouTube streaming details');
      if (item.snippet.liveBroadcastContent === 'live') {
        if (!timestamp(details.actualStartTime) || Date.parse(details.actualStartTime) > +now) throw new Error('Invalid YouTube actual start');
        result.push({ ...row, status: 'live', date: details.actualStartTime });
      } else if (item.snippet.liveBroadcastContent === 'upcoming') {
        if (!timestamp(details.scheduledStartTime)) throw new Error('Invalid YouTube scheduled start');
        // Premieres have a known, non-zero content duration before broadcasting.
        const duration = item.contentDetails?.duration;
        if (duration !== undefined && typeof duration !== 'string') throw new Error('Invalid YouTube duration');
        if (duration && !['P0D', 'PT0S'].includes(duration)) continue;
        result.push({ ...row, status: 'upcoming', date: details.scheduledStartTime });
      } else throw new Error('Invalid YouTube broadcast status');
    }
    // Missing IDs are private/deleted/cancelled and intentionally removed.
  }
  const twitch = records.filter(r => r.platform === 'twitch');
  if (twitch.length) {
    if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) throw new Error('Twitch credentials required');
    const token = await request('Twitch auth', 'https://id.twitch.tv/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }) });
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Invalid Twitch token');
    for (let i = 0; i < twitch.length; i += 100) {
      const batch = twitch.slice(i, i + 100);
      const url = new URL('https://api.twitch.tv/helix/streams');
      for (const row of batch) url.searchParams.append('user_login', row.identity);
      const items = arrayField(await request('Twitch streams', url, { headers: { 'Client-ID': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token.access_token}` } }), 'data');
      for (const item of items) {
        const row = batch.find(r => r.identity === item.user_login?.toLowerCase());
        if (!row || item.type !== 'live' || !timestamp(item.started_at) || Date.parse(item.started_at) > +now || !item.id) throw new Error('Invalid Twitch verification');
        result.push({ ...row, status: 'live', date: item.started_at });
      }
    }
  }
  return result;
}
