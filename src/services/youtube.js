/**
 * YouTube Data API v3 を使用して動画情報を取得するサービス
 *
 * 使用APIエンドポイント:
 *   channels.list / playlistItems.list - uploadsの差分を取得
 *   videos.list  - 動画の詳細情報を取得
 */

import { httpClient, arrayField } from '../schedule/http.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * ISO 8601 duration (PT1H2M3S) を秒数に変換する
 * @param {string} duration
 * @returns {number}
 */
function parseDurationToSeconds(duration) {
  if (!duration) return 0;
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const hours = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  const seconds = parseInt(match[3] ?? '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

const SHORTS_DURATION_THRESHOLD = 180; // 秒

const treatUncategorizedAsShorts =
  process.env.TREAT_UNCATEGORIZED_AS_SHORTS === 'true';

/**
 * 開始前・配信中など、記録対象外の動画かどうかを判定する
 * @param {{ snippet: object, liveStreamingDetails: object }} item YouTube API の raw item
 * @returns {{ skip: boolean, reason: string|null }}
 */
function shouldSkipVideo(item) {
  const liveContent = item.snippet?.liveBroadcastContent;
  const liveDetails = item.liveStreamingDetails;

  if (liveContent === 'upcoming') {
    return { skip: true, reason: 'upcoming' };
  }

  if (liveDetails?.scheduledStartTime && !liveDetails?.actualStartTime) {
    return { skip: true, reason: 'not-started' };
  }

  if (liveDetails?.actualStartTime && !liveDetails?.actualEndTime) {
    return { skip: true, reason: 'live-not-ended' };
  }

  return { skip: false, reason: null };
}

/**
 * 動画種別を判定する
 * 1. liveArchive（最優先）: actualStartTime と actualEndTime が両方ある
 * 2. shorts: タイトルに #shorts または #short を含む（大文字小文字不問）
 * 3. normal: duration が 180秒超
 * 4. uncategorized: duration が 180秒以下かつ上記タグなし（Shorts か通常投稿か確定不能）
 * @param {{ durationSeconds: number, actualStartTime: string|null, actualEndTime: string|null, title: string }} video
 * @returns {{ videoType: 'normal'|'shorts'|'liveArchive'|'uncategorized' }}
 */
function determineVideoType(video) {
  if (video.actualStartTime && video.actualEndTime) {
    return { videoType: 'liveArchive' };
  }

  const title = (video.title ?? '').toLowerCase();
  if (title.includes('#shorts') || title.includes('#short')) {
    return { videoType: 'shorts' };
  }

  if (video.durationSeconds > SHORTS_DURATION_THRESHOLD) {
    return { videoType: 'normal' };
  }

  return { videoType: treatUncategorizedAsShorts ? 'shorts' : 'uncategorized' };
}

/**
 * YouTube Data API search.list でチャンネルの動画IDを取得する
 * @param {string} channelId
 * @param {string} apiKey
 * @param {string} publishedAfter ISO8601 文字列
 * @returns {Promise<string[]>} videoId 配列
 */
export async function fetchVideoIds(channelId, apiKey, publishedAfter, { request = httpClient(), maxPages = 20 } = {}) {
  // channels.list supplies the authoritative uploads playlist; never use search.list (100 units).
  const channels = await request('YouTube channels', `${YOUTUBE_API_BASE}/channels?${new URLSearchParams({part:'contentDetails',id:channelId,key:apiKey})}`);
  const channel = arrayField(channels, 'items').find(item => item.id === channelId);
  const playlistId = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error('Uploads playlist unavailable');
  const ids = new Set();
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({part:'contentDetails',playlistId,maxResults:'50',key:apiKey});
    if (pageToken) params.set('pageToken', pageToken);
    const data = await request('YouTube playlist', `${YOUTUBE_API_BASE}/playlistItems?${params}`);
    let old = false;
    for (const item of arrayField(data, 'items')) {
      const {videoId, videoPublishedAt} = item.contentDetails ?? {};
      // Missing dates are included for details lookup; never guess a year.
      if (videoPublishedAt && Date.parse(videoPublishedAt) < Date.parse(publishedAfter)) old = true;
      else if (videoId) ids.add(videoId);
    }
    pageToken = data.nextPageToken;
    if (!pageToken || old) return [...ids];
  }
  throw new Error('Uploads pagination limit reached; watermark unchanged');
}

/**
 * YouTube Data API videos.list で動画詳細情報を取得する
 * @param {string[]} videoIds
 * @param {string} apiKey
 * @returns {Promise<Object[]>}
 */
export async function fetchVideoDetails(videoIds, apiKey, request = httpClient()) {
  const results = [];

  // API は一度に最大50件
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: 'snippet,contentDetails,liveStreamingDetails',
      id: chunk.join(','),
      key: apiKey,
    });

    const url = `${YOUTUBE_API_BASE}/videos?${params}`;
    const data = await request('YouTube videos', url);

    for (const item of arrayField(data, 'items')) {
      const snippet = item.snippet ?? {};
      const contentDetails = item.contentDetails ?? {};
      const liveDetails = item.liveStreamingDetails ?? {};
      const durationSeconds = parseDurationToSeconds(contentDetails.duration);

      // 開始前・配信中など記録対象外はスキップ
      const { skip, reason } = shouldSkipVideo(item);
      if (skip) {
        console.log(`[DEBUG] skipped videoId=${item.id} reason=${reason}`);
        continue;
      }

      const video = {
        videoId: item.id,
        title: snippet.title ?? '',
        url: `https://www.youtube.com/watch?v=${item.id}`,
        publishedAt: snippet.publishedAt ?? null,
        thumbnail: snippet.thumbnails?.medium?.url ?? null,
        channelId: snippet.channelId ?? '',
        channelTitle: snippet.channelTitle ?? '',
        duration: contentDetails.duration ?? '',
        durationSeconds,
        liveBroadcastContent: snippet.liveBroadcastContent ?? 'none',
        actualStartTime: liveDetails.actualStartTime ?? null,
        actualEndTime: liveDetails.actualEndTime ?? null,
        videoType: null,
      };

      if (!video.publishedAt || !Number.isFinite(Date.parse(video.publishedAt))) throw new Error('Missing video publication date');
      const { videoType } = determineVideoType(video);
      video.videoType = videoType;

      console.log(
        `[DEBUG] videoId=${video.videoId} rawDuration=${video.duration} duration=${video.durationSeconds}s videoType=${videoType}`
      );

      results.push(video);
    }
  }

  return results;
}

/**
 * 指定チャンネルから対象期間内の動画一覧を取得する
 * @param {string} channelId
 * @param {string} apiKey
 * @param {{ daysBack?: number }} options
 * @returns {Promise<Object[]>}
 */
export async function getChannelVideos(channelId, apiKey, options = {}) {
  const daysBack = options.daysBack ?? 14;
  const now = options.now ?? new Date();
  // Replay the overlap to catch delayed archives and late publication. A long outage
  // expands back to last success rather than silently dropping the gap.
  const since = options.lastSuccessAt && Number.isFinite(Date.parse(options.lastSuccessAt)) ? Math.min(+now, Date.parse(options.lastSuccessAt)) : +now;
  const publishedAfter = new Date(since - daysBack * 86400000).toISOString();
  const request = options.request ?? httpClient();
  const videoIds = await fetchVideoIds(channelId, apiKey, publishedAfter, { request });
  if (!videoIds.length) return [];
  return fetchVideoDetails(videoIds, apiKey, request);
}

// All list endpoints used here cost 1 unit. Count every HTTP attempt, including retries.
export function quotaRequest(limit = 40, fetchImpl = fetch) {
  const usage = { used: 0, limit };
  const transport = httpClient(async (url, options) => {
    if (usage.used >= limit) throw new Error('Video quota budget exhausted');
    usage.used++;
    return fetchImpl(url, options);
  });
  const request = async (label, url, options) => {
    if (usage.used >= limit) throw new Error('Video quota budget exhausted');
    return transport(label, url, options);
  };
  return { request, usage };
}
