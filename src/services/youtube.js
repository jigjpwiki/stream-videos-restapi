/**
 * YouTube Data API v3 を使用して動画情報を取得するサービス
 *
 * 使用APIエンドポイント:
 *   search.list  - チャンネルの動画ID一覧を取得
 *   videos.list  - 動画の詳細情報を取得
 */

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * ISO 8601 duration (PT1H2M3S) を秒数に変換する
 * @param {string} duration
 * @returns {number}
 */
function parseDurationToSeconds(duration) {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  const seconds = parseInt(match[3] ?? '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * 動画種別を判定する
 * @param {{ durationSeconds: number, liveBroadcastContent: string, actualStartTime: string|null, actualEndTime: string|null }} video
 * @returns {'normal'|'shorts'|'liveArchive'}
 */
function determineVideoType(video) {
  // ライブ配信アーカイブ判定
  if (video.actualEndTime) {
    return 'liveArchive';
  }

  // Shorts判定: 60秒以下の動画をShortsとみなす（YouTube APIだけでは完全判定不可のため暫定）
  if (video.durationSeconds > 0 && video.durationSeconds <= 60) {
    return 'shorts';
  }

  return 'normal';
}

/**
 * YouTube Data API search.list でチャンネルの動画IDを取得する
 * @param {string} channelId
 * @param {string} apiKey
 * @param {string} publishedAfter ISO8601 文字列
 * @returns {Promise<string[]>} videoId 配列
 */
async function fetchVideoIds(channelId, apiKey, publishedAfter) {
  const videoIds = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      part: 'id',
      channelId,
      type: 'video',
      maxResults: '50',
      order: 'date',
      publishedAfter,
      key: apiKey,
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const url = `${YOUTUBE_API_BASE}/search?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`YouTube search.list failed: ${res.status} ${body}`);
    }
    const data = await res.json();

    for (const item of data.items ?? []) {
      if (item.id?.videoId) {
        videoIds.push(item.id.videoId);
      }
    }

    pageToken = data.nextPageToken ?? null;
  } while (pageToken);

  return videoIds;
}

/**
 * YouTube Data API videos.list で動画詳細情報を取得する
 * @param {string[]} videoIds
 * @param {string} apiKey
 * @returns {Promise<Object[]>}
 */
async function fetchVideoDetails(videoIds, apiKey) {
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
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`YouTube videos.list failed: ${res.status} ${body}`);
    }
    const data = await res.json();

    for (const item of data.items ?? []) {
      const snippet = item.snippet ?? {};
      const contentDetails = item.contentDetails ?? {};
      const liveDetails = item.liveStreamingDetails ?? {};
      const durationSeconds = parseDurationToSeconds(contentDetails.duration);

      const video = {
        videoId: item.id,
        title: snippet.title ?? '',
        url: `https://www.youtube.com/watch?v=${item.id}`,
        publishedAt: snippet.publishedAt ?? null,
        channelId: snippet.channelId ?? '',
        channelTitle: snippet.channelTitle ?? '',
        duration: contentDetails.duration ?? '',
        durationSeconds,
        liveBroadcastContent: snippet.liveBroadcastContent ?? 'none',
        actualStartTime: liveDetails.actualStartTime ?? null,
        actualEndTime: liveDetails.actualEndTime ?? null,
        videoType: null,
      };

      // ライブ配信中はスキップ
      if (snippet.liveBroadcastContent === 'live') {
        continue;
      }

      video.videoType = determineVideoType(video);
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
  const publishedAfter = new Date(
    Date.now() - daysBack * 24 * 60 * 60 * 1000
  ).toISOString();

  const videoIds = await fetchVideoIds(channelId, apiKey, publishedAfter);
  if (videoIds.length === 0) {
    return [];
  }

  const videos = await fetchVideoDetails(videoIds, apiKey);
  return videos;
}
