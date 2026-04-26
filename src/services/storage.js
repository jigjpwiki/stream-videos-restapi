import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const CACHE_FILE = path.join(DATA_DIR, 'videos-cache.json');
const STATE_FILE = path.join(DATA_DIR, 'update-state.json');

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

/**
 * 登録済み動画キャッシュを読み込む
 * @returns {Object} { channelId: [{ videoId, title, registeredAt }] }
 */
export async function loadCache() {
  await ensureDataDir();
  if (!existsSync(CACHE_FILE)) {
    return {};
  }
  const raw = await readFile(CACHE_FILE, 'utf-8');
  return JSON.parse(raw);
}

/**
 * キャッシュを保存する
 * @param {Object} cache
 */
export async function saveCache(cache) {
  await ensureDataDir();
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * 指定チャンネルIDのキャッシュVideoIdセットを取得する
 * @param {Object} cache
 * @param {string} channelId
 * @returns {Set<string>}
 */
export function getCachedVideoIds(cache, channelId) {
  const entries = cache[channelId] ?? [];
  return new Set(entries.map((e) => e.videoId));
}

/**
 * キャッシュに動画を追加する（保存はしない）
 * @param {Object} cache
 * @param {string} channelId
 * @param {{ videoId: string, title: string }} video
 * @param {string} registeredAt ISO8601 文字列
 */
export function addToCache(cache, channelId, video, registeredAt) {
  if (!cache[channelId]) {
    cache[channelId] = [];
  }
  cache[channelId].push({
    videoId: video.videoId,
    title: video.title,
    registeredAt,
  });
}

/**
 * 処理状態を読み込む
 * @returns {{ lastIndex: number, updatedAt: string }}
 */
export async function loadState() {
  await ensureDataDir();
  if (!existsSync(STATE_FILE)) {
    return { lastIndex: 0, updatedAt: null };
  }
  const raw = await readFile(STATE_FILE, 'utf-8');
  return JSON.parse(raw);
}

/**
 * 処理状態を保存する
 * @param {{ lastIndex: number, updatedAt: string }} state
 */
export async function saveState(state) {
  await ensureDataDir();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}
