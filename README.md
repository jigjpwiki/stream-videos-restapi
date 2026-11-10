# stream-videos-restapi

YouTube動画記録 自動更新システム。複数ライバーのYouTubeチャンネルから動画情報を定期取得し、WIKIWIKI の各ライバーページへ自動追記する。

## 構成

```
src/
├─ config/
│  └─ livers.json          # ライバー設定（要編集）
├─ services/
│  ├─ youtube.js           # YouTube Data API v3 クライアント
│  ├─ wikiwiki.js          # WIKIWIKI REST API クライアント
│  └─ storage.js           # キャッシュ・状態ファイル管理
├─ formatter/
│  └─ wikiTextFormatter.js # Wiki 記法生成・挿入ロジック
├─ jobs/
│  └─ updateVideos.js      # 1ライバー分の更新ジョブ
└─ index.js                # エントリポイント（バッチ制御）
data/
├─ videos-cache.json       # 登録済み動画 ID キャッシュ
└─ update-state.json       # 対象別の最終成功・失敗状態
.github/workflows/
└─ update-videos.yml       # GitHub Actions 定期実行
```

## セットアップ

### 1. ライバー設定

`src/config/livers.json` を編集してライバー情報を登録する。

```json
[
  {
    "name": "ライバー名",
    "youtubeChannelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
    "wikiPageName": "ライバー名/動画一覧",
    "enabled": true
  }
]
```

### 2. GitHub Secrets 登録

| シークレット名     | 内容                                |
| ----------------- | ----------------------------------- |
| `YOUTUBE_API_KEY` | YouTube Data API v3 キー            |
| `WIKI_API_BASE_URL` | WIKIWIKI REST API ベース URL (例: `https://api.wikiwiki.jp/サイト名`) |
| `WIKI_PASSWORD`   | WIKIWIKI API トークン               |

### 3. 依存パッケージインストール

```bash
npm install
```

## 使い方

### 通常実行

```bash
npm run update
```

### Dry Run（Wiki を更新しない）

```bash
npm run update:dry
# または
DRY_RUN=true npm run update
```

### オプション環境変数

| 変数名       | デフォルト | 内容                           |
| ------------ | ---------- | ------------------------------ |
| `BATCH_SIZE` | `5`        | 1回に処理するライバー数        |
| `DAYS_BACK`  | `14`       | YouTube から取得する過去日数   |

## WIKIWIKI ページ構造

各ライバーの Wiki ページは以下の見出しを対象に動画を追記する。

| セクション見出し                           | 動画種別         |
| ------------------------------------------ | ---------------- |
| `**ライブ配信（アーカイブ） [#archives]`  | ライブ配信アーカイブ |
| `**投稿動画 [#edited_videos]`              | 通常投稿動画     |
| `***Shorts動画 [#shorts]`                  | Shorts 動画      |

セクションが存在しないページは自動更新をスキップする。

## 注意事項

- WIKIWIKI REST API のエンドポイント仕様は公式ドキュメントに合わせて `src/services/wikiwiki.js` を調整してください。
- Shortsはタグで判定し、180秒以下でタグのない動画は未分類として扱います。必要に応じて `src/services/youtube.js` の `determineVideoType` を調整してください。

## Wiki配信スケジュールと共通起動

[導入・Dry Run・Secrets・有効化・復旧手順](docs/stream-schedule.md)を参照。書き込みはデフォルト無効です。`npm test` / `npm run schedule:demo` は本番APIを使いません。

## 共通10分同期

[PR 1の設計・クォータ・安全制御・段階切替](docs/unified-sync.md)。動画の書込みは既定無効。
