/**
 * エントリポイント
 *
 * 環境変数:
 *   YOUTUBE_API_KEY   - YouTube Data API v3 キー
 *   WIKI_API_BASE_URL - WIKIWIKI REST API ベース URL
 *   WIKI_PASSWORD     - WIKIWIKI API トークン
 *   BATCH_SIZE        - 1回の実行で処理するライバー数 (デフォルト: 5)
 *   DRY_RUN           - "true" にすると Wiki 更新を行わない
 *   DAYS_BACK         - 取得対象期間（日数、デフォルト: 14）
 */

import 'dotenv/config';
console.log('YOUTUBE_API_KEY:', process.env.YOUTUBE_API_KEY);

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadState, saveState } from './services/storage.js';
import { updateLiverVideos } from './jobs/updateVideos.js';

// .env 読み込み（ローカル実行時のみ。GitHub Actions ではシークレットを使用）
try {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
} catch {
  // dotenv が存在しない環境でも継続
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVERS_FILE = path.resolve(__dirname, 'config/livers.json');
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '5', 10);

async function main() {
  console.log('[INFO] Start update job');

  // 必須環境変数チェック
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] YOUTUBE_API_KEY is not set');
    process.exit(1);
  }
  if (!process.env.WIKI_API_BASE_URL) {
    console.error('[ERROR] WIKI_API_BASE_URL is not set');
    process.exit(1);
  }
  if (!process.env.WIKI_PASSWORD) {
    console.error('[ERROR] WIKI_PASSWORD is not set');
    process.exit(1);
  }

  // ライバー一覧読み込み
  const livers = JSON.parse(await readFile(LIVERS_FILE, 'utf-8'));
  const enabledLivers = livers.filter((l) => l.enabled);

  if (enabledLivers.length === 0) {
    console.log('[INFO] No enabled livers found');
    return;
  }

  // 前回処理位置を読み込み、バッチ対象を決定
  const state = await loadState();
  const startIndex = state.lastIndex % enabledLivers.length;
  const actualBatchSize = Math.min(BATCH_SIZE, enabledLivers.length);
  const targets = [];

  for (let i = 0; i < actualBatchSize; i++) {
    const idx = (startIndex + i) % enabledLivers.length;
    targets.push(enabledLivers[idx]);
  }

  console.log(
    `[INFO] Processing ${targets.length} livers (start index: ${startIndex})`
  );

  // 各ライバーを順番に処理（失敗しても他は継続）
  for (const liver of targets) {
    try {
      const result = await updateLiverVideos(liver, apiKey);
      if (!result.success) {
        console.warn(`[WARN] Update failed for ${liver.name}`);
      }
    } catch (err) {
      console.error(`[ERROR] Unexpected error for ${liver.name}: ${err.message}`);
    }
  }

  // 処理状態を保存
  const nextIndex = (startIndex + actualBatchSize) % enabledLivers.length;
  await saveState({
    lastIndex: nextIndex,
    updatedAt: new Date().toISOString(),
  });

  console.log('[INFO] Job finished');
}

main().catch((err) => {
  console.error('[ERROR] Fatal error:', err);
  process.exit(1);
});
