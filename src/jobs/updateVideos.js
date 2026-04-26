/**
 * updateVideos ジョブ
 *
 * 1件のライバーに対して以下を実行する:
 *   1. YouTube API で動画取得
 *   2. キャッシュ & Wiki 本文で重複確認
 *   3. 新規動画を Wiki に挿入
 *   4. キャッシュ更新・保存
 */

import { getChannelVideos } from '../services/youtube.js';
import { getPage, updatePage } from '../services/wikiwiki.js';
import {
  loadCache,
  saveCache,
  getCachedVideoIds,
  addToCache,
} from '../services/storage.js';
import {
  insertVideoIntoPage,
  isVideoAlreadyInPage,
} from '../formatter/wikiTextFormatter.js';

const DRY_RUN = process.env.DRY_RUN === 'true';
const DAYS_BACK = parseInt(process.env.DAYS_BACK ?? '14', 10);

/**
 * 1ライバー分の動画更新処理
 * @param {{ name: string, youtubeChannelId: string, wikiPageName: string }} liver
 * @param {string} apiKey YouTube API キー
 * @returns {Promise<{ success: boolean, newVideosCount: number }>}
 */
export async function updateLiverVideos(liver, apiKey) {
  const { name, youtubeChannelId, wikiPageName } = liver;
  console.log(`[INFO] Target: ${name}`);

  // 1. YouTube 動画取得
  let videos;
  try {
    videos = await getChannelVideos(youtubeChannelId, apiKey, { daysBack: DAYS_BACK });
    console.log(`[INFO] Fetched videos: ${videos.length}`);
  } catch (err) {
    console.error(`[ERROR] YouTube API error for ${name}: ${err.message}`);
    return { success: false, newVideosCount: 0 };
  }

  if (videos.length === 0) {
    console.log(`[INFO] No videos found for ${name}`);
    return { success: true, newVideosCount: 0 };
  }

  // 2. キャッシュ読み込み
  const cache = await loadCache();
  const cachedIds = getCachedVideoIds(cache, youtubeChannelId);

  // 3. Wiki 本文取得
  let pageText;
  try {
    pageText = await getPage(wikiPageName);
  } catch (err) {
    console.error(`[ERROR] Wiki GET failed for ${name}: ${err.message}`);
    return { success: false, newVideosCount: 0 };
  }

  // 4. 新規動画のみ抽出（キャッシュ & ページ本文でダブルチェック）
  const newVideos = videos.filter(
    (v) =>
      !cachedIds.has(v.videoId) && !isVideoAlreadyInPage(pageText, v.videoId)
  );

  console.log(`[INFO] New videos: ${newVideos.length}`);

  if (newVideos.length === 0) {
    return { success: true, newVideosCount: 0 };
  }

  // 5. 動画を日付昇順（古い順）で挿入する
  const sorted = [...newVideos].sort(
    (a, b) => new Date(a.publishedAt) - new Date(b.publishedAt)
  );

  let updatedText = pageText;
  const registeredVideos = [];

  for (const video of sorted) {
    const result = insertVideoIntoPage(updatedText, video);
    if (result === null) {
      console.warn(
        `[WARN] Section not found for videoType="${video.videoType}", skipping: ${video.videoId}`
      );
      continue;
    }
    updatedText = result;
    registeredVideos.push(video);
  }

  if (registeredVideos.length === 0) {
    return { success: true, newVideosCount: 0 };
  }

  // 6. Wiki 更新
  if (DRY_RUN) {
    console.log('[DRY_RUN] Wiki update skipped. Generated text preview:');
    console.log(updatedText.slice(0, 500));
  } else {
    try {
      await updatePage(wikiPageName, updatedText);
      console.log(`[INFO] Wiki updated: ${wikiPageName}`);
    } catch (err) {
      console.error(`[ERROR] Wiki PUT failed for ${name}: ${err.message}`);
      return { success: false, newVideosCount: 0 };
    }
  }

  // 7. キャッシュ更新（DRY_RUN でも更新しない）
  if (!DRY_RUN) {
    const now = new Date().toISOString();
    for (const video of registeredVideos) {
      addToCache(cache, youtubeChannelId, video, now);
    }
    await saveCache(cache);
  }

  return { success: true, newVideosCount: registeredVideos.length };
}
