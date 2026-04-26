# YouTube動画記録 自動更新システム 仕様書

## 1. 目的

本システムは、複数のライバーのYouTubeチャンネルから投稿動画情報を定期的に取得し、WIKIWIKI上の各ライバー個別ページへ動画記録として自動追記することを目的とする。

対象とする動画は以下の3種類とする。

- 通常の横動画
- YouTube Shorts
- ライブ配信のアーカイブ

各ライバーの動画情報は、WIKIWIKI内の以下のページに記録する。

```text
[ライバー名/動画一覧]
```

GitHub Codespaces上で開発し、GitHub Actionsを用いて定期実行する。

---

## 2. 全体構成

```text
GitHub Repository
├─ src/
│  ├─ config/
│  │  └─ livers.json
│  ├─ services/
│  │  ├─ youtube.js
│  │  ├─ wikiwiki.js
│  │  └─ storage.js
│  ├─ formatter/
│  │  └─ wikiTextFormatter.js
│  ├─ jobs/
│  │  └─ updateVideos.js
│  └─ index.js
├─ data/
│  ├─ videos-cache.json
│  └─ update-state.json
├─ docs/
│  └─ spec.md
├─ .github/
│  └─ workflows/
│     └─ update-videos.yml
├─ package.json
└─ README.md
```

---

## 3. 処理概要

### 3.1 定期実行

GitHub Actionsで1日に複数回スクリプトを実行する。

実行タイミングは厳密に固定せず、YouTube APIのクオータ消費を抑えるため、全ライバーを一度に処理せず、数十人を分割して処理する。

例：

```text
1回の実行で5〜10人分を処理
1日を通して全員分が数回チェックされるようにする
```

---

## 4. 対象データ

### 4.1 ライバー情報

ライバー情報は `src/config/livers.json` で管理する。

```text
src/config/livers.json
```

JSON形式は以下とする。

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

`wikiPageName` には、更新対象のWIKIWIKIページ名を `/動画一覧` まで含めて記載する。

例：

```json
{
  "name": "天堂ライラ",
  "youtubeChannelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "wikiPageName": "天堂ライラ/動画一覧",
  "enabled": true
}
```

大量のライバー情報を仕様書本文に直接貼ると管理が難しくなるため、仕様書にはデータ形式のみを記載し、実データは `src/config/livers.json` として管理する。

### 4.2 管理する主な項目

| 項目 | 内容 |
|---|---|
| name | 表示用ライバー名 |
| youtubeChannelId | YouTubeチャンネルID |
| wikiPageName | 更新対象のWIKIWIKIページ名 |
| enabled | 自動更新対象にするか |

---

## 5. YouTube API取得仕様

### 5.1 取得対象

YouTube Data APIを使用し、各チャンネルから以下の動画を取得する。

- 通常動画
- Shorts
- ライブ配信アーカイブ

### 5.2 取得対象期間

初期案として、直近数日〜数週間分の動画を取得対象とする。

重複登録を避けるため、過去に登録済みの動画IDはキャッシュで管理する。

```text
videoId を一意キーとして扱う
```

### 5.3 取得する情報

| 項目 | 内容 |
|---|---|
| videoId | YouTube動画ID |
| title | 動画タイトル |
| url | 動画URL |
| publishedAt | 公開日時 |
| channelId | チャンネルID |
| channelTitle | チャンネル名 |
| duration | 動画時間 |
| liveBroadcastContent | ライブ状態 |
| actualStartTime | ライブ開始時刻 |
| actualEndTime | ライブ終了時刻 |
| videoType | normal / shorts / liveArchive |

---

## 6. 動画種別判定

### 6.1 通常動画

以下に該当する場合、通常動画として扱う。

- ライブ配信ではない
- Shortsではない
- 動画時間やURL形式からShortsと判定されない

### 6.2 Shorts

Shorts判定は、以下の条件を組み合わせて行う。

- 動画時間が短い
- YouTube上でShorts URLとして扱える
- 必要に応じてタイトルやメタ情報も参照

ただし、YouTube APIのみでShortsを完全に判定することは難しいため、判定ロジックは後から調整可能にする。

### 6.3 ライブ配信アーカイブ

以下に該当する場合、ライブ配信アーカイブとして扱う。

- ライブ配信として開始された動画である
- `actualEndTime` が存在する
- 配信終了後、アーカイブとして視聴可能になっている

ライブ配信中のものは、今回の記録対象には含めない。

---

## 7. 重複防止仕様

### 7.1 一意キー

動画の重複判定には `videoId` を使用する。

```text
同じ videoId がすでにWikiまたはキャッシュに存在する場合は追記しない
```

### 7.2 キャッシュファイル

`data/videos-cache.json` に登録済み動画を保存する。

```json
{
  "UCxxxxxxxxxxxxxxxxxxxxxx": [
    {
      "videoId": "abc123",
      "title": "動画タイトル",
      "registeredAt": "2026-04-26T00:00:00+09:00"
    }
  ]
}
```

### 7.3 Wiki本文側の確認

キャッシュが壊れた場合に備えて、更新前に対象ページ本文も取得し、`videoId` または動画URLが既に含まれていないか確認する。

---

## 8. Wiki更新仕様

### 8.1 更新対象ページ

各ライバーごとに以下のページを更新する。

```text
ライバー名/動画一覧
```

### 8.2 更新方式

WIKIWIKI REST APIを使用して、対象ページ本文を取得・編集・保存する。

処理の流れは以下の通り。

```text
1. 対象ページ本文を取得
2. 自動更新対象セクションを検出
3. 新規動画の記録文を生成
4. 既存本文に挿入
5. WIKIWIKI REST APIでページを更新
```

### 8.3 自動更新対象セクション

本システムでは、ページ全体に専用の自動更新マーカーを追加せず、既存ページの見出しを基準に挿入位置を判定する。

挿入対象の見出しは以下とする。

```wiki
**ライブ配信（アーカイブ） [#archives]
**投稿動画 [#edited_videos]
***Shorts動画 [#shorts]
```

スクリプトは、対象見出しから次の同階層または上位階層の見出しまでを対象範囲として扱う。

対象セクションが見つからない場合は、安全のため自動更新を行わない。

### 8.4 追記方式

基本方針は以下とする。

- 新しい動画を下に追加する
- 既存の記録は保持する
- 同じ動画IDは重複追加しない
- 手動編集部分は壊さない

---

## 9. Wiki記載フォーマット

### 9.1 基本方針

WIKIWIKIの各ライバー動画一覧ページは、既存のページ構造を維持したまま、該当セクションに動画情報を追記する。

新しい動画は、各セクション・各年・各月の既存リストの一番下に追加する。

```text
古い動画
↓
新しい動画
```

### 9.2 対象ページ名

各ライバーごとのページ名は以下の形式とする。

```text
ライバー名/動画一覧
```

例：

```text
天堂ライラ/動画一覧
```

### 9.3 動画種別ごとの挿入先

取得した動画は、種別ごとに以下のセクションへ記載する。

| 動画種別 | 挿入先セクション |
|---|---|
| ライブ配信アーカイブ | `**ライブ配信（アーカイブ） [#archives]` |
| 歌動画 | `**歌動画 [#songs]` ※自動判定対象外 |
| 公式番組 | `***公式番組 [#official_programs]` ※自動判定対象外の想定 |
| 公式動画・公式切り抜き | `***公式動画・公式切り抜き [#official_kirinuki]` ※自動判定対象外の想定 |
| 通常投稿動画 | `**投稿動画 [#edited_videos]` |
| Shorts動画 | `***Shorts動画 [#shorts]` |

初期実装では、YouTube APIから自動取得して分類する対象は以下の3種類とする。

```text
- ライブ配信アーカイブ
- 通常投稿動画
- Shorts動画
```

歌動画・公式動画・公式切り抜きは、タイトルやチャンネル情報だけでは誤判定の可能性が高いため、初期実装では自動追記対象外とする。必要に応じて、後から手動ルールまたはタグ付けルールで対応する。

### 9.4 記載形式

動画1件あたりの基本フォーマットは以下とする。

```wiki
-MM/DD &color(red){■};[[タイトル:https://www.youtube.com/watch?v=VIDEO_ID]]
```

例：

```wiki
-04/16 &color(red){■};[[【初投稿】はじめまして！天堂ライラです！#パレデミア学園 #新人Vtuber #Vtuber準備中:https://www.youtube.com/watch?v=tsV3ChhuAfs]]
```

### 9.5 色指定

現時点では、自分のチャンネルで公開されたYouTube動画は以下の色を使用する。

```wiki
&color(red){■};
```

ページ上部の凡例は以下を前提とする。

```wiki
【YouTube】&color(red){■};ライバー名 / &color(maroon){■};パレデミア学園 / &color(gray){■};その他
```

初期実装では、対象ライバー本人のYouTubeチャンネルから取得した動画のみを扱うため、基本的に `red` を使用する。

### 9.6 ライブ配信アーカイブの構造

ライブ配信アーカイブは、以下のセクションに追加する。

```wiki
**ライブ配信（アーカイブ） [#archives]
***2026年 [#archives2026]
#fold(4月){{
''4月''
-04/00 &color(red){■};[[タイトル:https://www.youtube.com/watch?v=VIDEO_ID]]
}}
```

既存テンプレートでは月ごとの `#fold` がコメントアウトされている場合がある。

そのため、対象月の `#fold` がコメントアウトされている場合は、コメントを解除して使用する。

例：

```wiki
//#fold(4月){{
//''4月''
//-04/00 &color(Red){■};[[タイトル>https://example.com]]
//}}
```

↓

```wiki
#fold(4月,open){{
''4月''
-04/26 &color(red){■};[[タイトル:https://www.youtube.com/watch?v=VIDEO_ID]]
}}
```

当月のみ `open` にするか、すべてcloseにするかは運用方針に応じて調整する。

### 9.7 通常投稿動画の構造

通常投稿動画は、以下のセクションに追加する。

```wiki
**投稿動画 [#edited_videos]
#fold(2026年,open){{
''2026年''
-04/26 &color(red){■};[[タイトル:https://www.youtube.com/watch?v=VIDEO_ID]]
}}
```

年別foldの中に、日付順で下に追記する。

### 9.8 Shorts動画の構造

Shorts動画は、以下のセクションに追加する。

```wiki
***Shorts動画 [#shorts]
#fold(2026年,open){{{
''2026年''
#fold(4月,open){{
''4月''
-04/26 &color(red){■};[[タイトル:https://www.youtube.com/watch?v=VIDEO_ID]]
}}
}}}
```

Shortsは、年別foldの中に月別foldを作成し、対象月の末尾に追記する。

ページ内コメントに従い、当月のみ `open`、過去月はcloseとする運用を想定する。

```wiki
//当月のみopen、次の月になったらclose
```

### 9.9 年・月セクションが存在しない場合

対象年や対象月のfoldが存在しない場合、スクリプト側で自動生成する。

#### 年foldの例

```wiki
#fold(2026年,open){{
''2026年''
}}
```

#### Shorts月foldの例

```wiki
#fold(4月,open){{
''4月''
}}
```

#### ライブ配信アーカイブ月foldの例

```wiki
#fold(4月,open){{
''4月''
}}
```

### 9.10 年切り替え時の挙動（重要）

年が切り替わるタイミングで、以下の処理を行う。

#### 基本ルール

- 既存年（例：2026年）のfoldを `close` 状態に変更する
- 新しい年（例：2027年）のfoldを `open` 状態で作成する
- 新しい動画は新しい年のfoldに記録する

#### 例（2026 → 2027）

変更前：

```wiki
#fold(2026年,open){{
''2026年''
-12/31 ...
}}
```

変更後：

```wiki
#fold(2026年){{
''2026年''
-12/31 ...
}}

#fold(2027年,open){{
''2027年''
-01/01 ...
}}
```

#### 実装ルール

- 現在年（JST）を基準に処理する
- 対象年のfoldが存在しない場合は新規作成する
- 直前の年のfoldが `open` の場合は `close` に変更する

#### 注意点

- 既存の手動編集内容は保持する
- 年foldの順序は「古い年 → 新しい年」の順で下に追加する
- 年foldが複数 `open` にならないように制御する

### 9.11 タイトル内の記号処理

YouTube動画タイトルには、WIKIWIKI構文に影響する文字が含まれる可能性がある。

特に以下は注意する。

```text
[ ]
: 
>
改行
```

本システムでは、リンク構文として以下の両方に対応する。

```wiki
[[タイトル:URL]]
[[タイトル>URL]]
```

タイトル内に `:` が含まれる場合、WIKIWIKI側でリンク区切りとして誤解釈される可能性があるため、必要に応じてタイトルをエスケープまたは置換する。

初期実装では、以下の安全処理を行う。

```text
- 改行をスペースに置換
- 連続スペースを1つにまとめる
- `]]` を全角または別表現に置換
```

### 9.11 重複防止

動画URLまたはvideoIdがページ本文内にすでに存在する場合は追記しない。

確認対象：

```text
https://www.youtube.com/watch?v=VIDEO_ID
VIDEO_ID
```

### 9.12 実装上の重要ポイント

ページ全体に明確な自動更新マーカーがないため、以下のセクション見出しを基準に挿入位置を判定する。

```wiki
**ライブ配信（アーカイブ） [#archives]
**投稿動画 [#edited_videos]
***Shorts動画 [#shorts]
```

スクリプトは、該当見出しから次の同階層または上位階層の見出しまでを対象範囲として扱う。

誤編集を防ぐため、対象セクションが見つからない場合はページ更新を中止する。

---

## 10. 分割実行仕様

### 10.1 目的

数十人分のYouTube API取得を一度に行うと、以下の問題が発生する可能性がある。

- YouTube APIクオータの大量消費
- GitHub Actionsの実行時間増加
- Wiki APIへの連続アクセス負荷
- 失敗時の影響範囲が大きい

そのため、1回の実行で処理するライバー数を制限する。

### 10.2 処理対象の決定

`data/update-state.json` に前回処理位置を保存し、次回実行時に続きから処理する。

```json
{
  "lastIndex": 12,
  "updatedAt": "2026-04-26T00:00:00+09:00"
}
```

例：

```text
全ライバー数：50人
1回の処理人数：5人
1日10回実行すれば、全員を1日1回処理可能
```

必要に応じて、1回あたりの人数や実行頻度を増やす。

---

## 11. GitHub Actions仕様

### 11.1 実行トリガー

以下の2種類を用意する。

- 定期実行
- 手動実行

```yaml
on:
  schedule:
    - cron: "0 */2 * * *"
  workflow_dispatch:
```

初期案では2時間ごとに実行する。

### 11.2 環境変数

GitHub Secretsに以下を登録する。

```text
YOUTUBE_API_KEY
WIKI_PASSWORD
WIKI_API_BASE_URL
```

WIKIWIKI REST APIの認証方式に合わせて調整する。

---

## 12. エラー処理

### 12.1 YouTube API取得失敗

- 対象ライバーの処理をスキップする
- エラーログを出力する
- 他のライバーの処理は継続する

### 12.2 Wiki本文取得失敗

- 対象ライバーの更新を中止する
- キャッシュは更新しない

### 12.3 Wiki更新失敗

- キャッシュは更新しない
- 次回実行時に再試行する

### 12.4 マーカー未検出

- 自動更新しない
- エラーとしてログに出す

---

## 13. ログ仕様

実行時には以下をログ出力する。

```text
- 実行開始時刻
- 処理対象ライバー
- 取得した動画数
- 新規追加対象の動画数
- Wiki更新成功 / 失敗
- YouTube APIエラー
- Wiki APIエラー
```

例：

```text
[INFO] Start update job
[INFO] Target: ライバー名
[INFO] Fetched videos: 8
[INFO] New videos: 2
[INFO] Wiki updated: ライバー名/動画一覧
[INFO] Job finished
```

---

## 14. セキュリティ

### 14.1 APIキー管理

APIキーやトークンはコードに直接書かない。

必ずGitHub Secretsを使用する。

### 14.2 Wiki更新範囲の制限

スクリプトは、指定された見出しセクション内のみ編集する。

対象外のセクションやページ全体を不用意に上書きしない。

### 14.3 Dry Run

本番更新前に、Wiki更新を行わず生成結果だけ確認できる `DRY_RUN` モードを用意する。

```bash
DRY_RUN=true npm run update
```

---

## 15. 開発環境

### 15.1 使用環境

- GitHub Codespaces
- Node.js
- GitHub Actions
- YouTube Data API
- WIKIWIKI REST API

### 15.2 想定コマンド

```bash
npm install
npm run update
npm run update:dry
```

---

## 16. 実装ステップ

### Step 1: プロジェクト初期化

- Node.jsプロジェクト作成
- `package.json` 作成
- ディレクトリ構成作成

### Step 2: ライバー設定ファイル作成

- `src/config/livers.json` を作成
- ライバー名、YouTubeチャンネルID、Wikiページ名、有効フラグを登録
- `wikiPageName` は `/動画一覧` まで含めた完全なページ名にする

### Step 3: YouTube API取得処理

- チャンネルごとの投稿動画取得
- 動画詳細取得
- 動画種別判定

### Step 4: Wiki記法フォーマット生成

- 共有された記載フォーマットに合わせて整形
- JSTの日付に変換

### Step 5: Wiki本文取得・更新処理

- WIKIWIKI REST APIで本文取得
- マーカー内更新
- ページ保存

### Step 6: 重複防止

- `videoId` ベースのキャッシュ実装
- Wiki本文内の既存URL確認

### Step 7: GitHub Actions化

- 定期実行設定
- Secrets設定
- 手動実行対応

### Step 8: 本番運用調整

- 実行頻度調整
- 処理人数調整
- ログ確認
- 失敗時の再実行確認

---

## 17. 未確定事項 / 確認が必要な情報

以下の情報が確定次第、仕様を更新する。

### 17.1 WIKIWIKI REST API関連

WIKIWIKI REST APIは以下の仕様を前提とする。

公式サンプルドキュメント：

```text
https://wikiwiki.jp/sample/REST%20API
```

#### ベースURL

対象Wikiは以下とする。

```text
https://wikiwiki.jp/jigjp/
```

APIベースURLは以下となる。

```text
https://api.wikiwiki.jp/jigjp/...
```

#### 認証

```http
POST https://api.wikiwiki.jp/jigjp/auth
Content-Type: application/json

{
  "password": "<WIKI_PASSWORD>"
}
```

レスポンス：

```json
{
  "status": "ok",
  "token": "eyJ0eXA..."
}
```

取得した `token` は、以後のリクエストで以下のように使用する。

```http
Authorization: Bearer <token>
```

注意点：

- トークンの有効期限は24時間
- 管理者パスワードを使用する
- サブ・パスワードは使用できない
- パスワードは**絶対にコードや仕様書に直接記載せず、GitHub Secretsで管理すること**

#### ページ一覧取得

```http
GET https://api.wikiwiki.jp/<wiki-name>/pages
Authorization: Bearer <token>
```

#### ページ本文取得

```http
GET https://api.wikiwiki.jp/<wiki-name>/page/<page-name>
Authorization: Bearer <token>
```

レスポンス例：

```json
{
  "page": "FrontPage",
  "source": "TITLE:FrontPage...",
  "timestamp": "2022-01-01T00:00:00+09:00"
}
```

#### ページ本文更新

```http
PUT https://api.wikiwiki.jp/<wiki-name>/page/<page-name>
Authorization: Bearer <token>
Content-Type: application/json

{
  "source": "更新後のページ本文"
}
```

レスポンス例：

```json
{
  "status": "ok"
}
```

#### レートリミット

- 1つのWikiあたり1時間に2000回まで
- 1分間に120回を超えるペースでは操作不可
- レートリミットはトークン単位ではなくWiki全体の操作回数に対してかかる

#### 本システムでの扱い

1ライバーを更新する際、最低でも以下の操作が発生する。

```text
1. 認証 ※毎回ではなく、実行単位で1回
2. ページ本文取得
3. ページ本文更新
```

そのため、1回のGitHub Actions実行で処理するライバー数を制限し、Wiki APIへのアクセス間隔も必要に応じて設ける。

### 17.2 Wiki記載フォーマット

Wiki記載フォーマットは確定済み。

基本形式：

```wiki
-MM/DD &color(red){■};[[タイトル:https://www.youtube.com/watch?v=VIDEO_ID]]
```

以下の方針で実装する。

- ライブ配信アーカイブ、通常投稿動画、Shorts動画のみ自動追記する
- 歌動画、公式番組、公式動画・公式切り抜きは自動判定対象外
- 新しい動画は下に追加する
- `[[本文:リンク]]` と `[[本文>リンク]]` の両方を既存リンクとして認識する
- 生成時は原則 `[[本文:リンク]]` に統一する

### 17.3 対象ライバー情報

対象ライバー情報は `src/config/livers.json` で管理する。

現時点では約69名規模を想定する。

`wikiPageName` は `/動画一覧` まで含めた完全なページ名を記載する。

### 17.4 実行頻度

初期運用では、GitHub Actionsを2時間ごとに実行する。

1回あたり7人前後を処理し、1日を通して全員を1回以上チェックできる設計とする。

### 17.5 初回登録範囲

- 過去動画をどこまで遡って登録するか
- 初回だけ全件取得するか
- 初回も直近分だけにするか

---

## 18. 初期方針

現時点での推奨方針は以下とする。

```text
- GitHub Actionsで2時間ごとに実行
- 1回あたり5〜10人を処理
- videoIdで重複防止
- Wiki本文にもURL存在確認を行う
- 自動更新範囲は既存見出しセクションで制御
- 初回はDRY_RUNで生成結果を確認
- 問題なければ本番更新を有効化
```

---

## 19. 今後の拡張候補

- Twitch動画・配信アーカイブ対応
- Wiki更新結果のDiscord通知
- GitHub Issueへのエラーログ投稿
- 手動で特定ライバーのみ更新する機能
- YouTube APIクオータ使用量の記録
- Shorts判定ロジックの改善
- 動画サムネイルの取得
- 年別・月別ページへの分割

