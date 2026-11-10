# Shorts・投稿動画の分類管理（PR 2）

PR 1の共通10分起動・writer排他・Wikiガード・専用state branchを使う別PR。
本番Worker、Access、Secrets、GitHub変数はこのPRでは変更しない。

## 構成と無料運用

- `ops/classifier/worker.mjs`: Workers上のPC/スマートフォン対応UI・API。
- SQLite Durable Object 1個に動画候補、分類revision、前回分類、反映receipt、履歴を永続化。
- ActionsがWikiの過去未分類行を巡回収集し、専用APIへ送信。管理画面はWikiへ直接書き込まない。
- 同じ動画が別ライバーページにあっても`page + videoId`で独立管理。
- 外部DBや有料サービスは不要。Workers Free / SQLite DO対応アカウントで使う。
  10分ごとの内部APIは通常数〜最大約100回/tick（50件反映時）。編集者の操作を含め、
  Workers 100,000 requests/日、DO無料枠（request、duration、SQL読書き・保存量）をダッシュボードで監視。
  履歴は消さないため長期保存量を監視し、枠超過が近ければ運用承認の上でバックアップ・整理する。
  無料枠を超えないことを無条件に保証する設計ではない。

## UI

認証済み編集者に1件ずつカードを表示。サムネイル・タイトル・ライバー・公開日（JST）・時間・動画リンク。
左スワイプ/←はShorts、右/→は投稿、下/↓は保留。ボタンでも操作できる。
直前操作の取り消しはrevision付きで保存。再読み込み後は「分類済み・修正」から変更できる。
履歴は編集者・日時・分類・Wiki結果を50件ずつ表示する。
未分類、分類済み、Wiki反映待ち、保留の件数を表示し、通信失敗・別編集者の競合は同じカードを保持する。
保留は反映せず未分類一覧の末尾へ。複数編集者の古いカードはHTTP 409で拒否する。
APIタイトル等はtextContentで表示し、行・画像・リンクからscriptを実行しない。外部動画は新しいタブで開く。

## 認証・権限分離

1. カスタムホストをCloudflare AccessのSelf-hosted Applicationで保護する。
   許可編集者メールのAllowポリシーを設定。無条件Bypassを設定しない。
2. `ACCESS_ISSUER=https://<team>.cloudflareaccess.com`、`ACCESS_AUD`、`EDITOR_EMAILS`（カンマ区切り）を設定。
   Worker自身もRS256署名・JWKS・issuer/audience/exp/iat/nbfとメール許可リストを検証する。
   メールヘッダーだけでは認証しない。設定不備・未知鍵・JWKS取得失敗は拒否する。
   鍵は5分キャッシュするためAccessの鍵更新直後は一時的な拒否があり得る。
3. `workers_dev=false`のまま、カスタムドメイン/routeを運用時に追加する。
   `/internal/*`だけAccessのService Auth（別Service Token）または適切なpath policyを設定し、
   Actionsから届くようにする。pathをAccessのBypassにする場合でもWorkerの専用Bearer照合は必須。
   Service Auth採用時は別途transportにCF-Access-Client-Id/Secretを設定する拡張が必要。
   現実装の最小構成は内部pathのみAccess Bypass + Workerの十分長い専用Bearer。
4. ランダム32文字以上の`SYNC_TOKEN`をWorker Secretへ登録し、同じ値をGitHub Secret
   `CLASSIFIER_SYNC_TOKEN`へ登録。チャット/ソース/varsへSecret値を書かない。
   `CLASSIFIER_URL`はHTTPSカスタムホストのoriginのみ（末尾slashなし）。
5. 編集者のAPIはsame-origin・JSON・独自ヘッダーを必須にし、CORSを提供しない。
   CSP、no-store、frame-ancestors none、Referrer-Policyで保護する。

ブラウザへYouTubeキー、Wiki認証、GitHubトークン、内部sync tokenは一切渡さない。
内部Tokenには候補import・queue読取・反映準備/ack権限のみ。GitHub dispatchやコード変更権限はない。
既存scheduler Worker・DO・Actions用Tokenの権限は拡張しない。管理WorkerにはGitHub Token不要。

## 過去動画の収集とメタデータ

Actionsは毎tick最大5ページを巡回する。有効52人だけでなく設定73人全員の過去ページを対象とし、
約15 tick（150分）で一巡する（取得失敗ページも次巡回で再試行）。初回一斉YouTube取得はしない。
`***Shorts・投稿動画未分類（自動取得） [#uncategorized]`の範囲内にある動画行だけを収集する。
同一ページの重複行はUI候補を1件とし、Wiki適用時は重複を検出して書込みを拒否する。
既存cacheの取得済み詳細を利用。不足分だけvideos.listへ最大50 IDs/tickを問い合わせる。
物理HTTP試行は分類用最大3 units/tick、通常は1 unit。PR 1の動画用40 units/tickとは別枠。
過去のMM/DD表記から公開年を推測しない。公開日不明/非公開動画は表示を確認中にし、移動を保留する。
APIで確定したpublishedAtをJSTにして、Shortsは年/月、投稿動画は年へ移動する。
元のタイトル・URL・日付を含む動画行は完全に維持する。

## Wiki反映と失敗復旧

共通runのschedule→classifications→videosの順で実行する。
対象ごとに最新本文を取得し、元の未分類行のみを削除、既存フォーマッターで移動先を作る。
分類前に人間がすでに移動・削除した行は`external`として反映済みにし、システムが移動し直さない。
人間分類は管理画面からも変更を拒否し、Wiki側で修正する。
システムの反映receipt（元行・分類・見出し/年/月位置）と現在行が一致する場合だけ、分類修正/取り消しで再移動できる。
人間が行や配置を変更した場合は自動修正しない。メタデータ更新や動画cacheは確定分類を上書きしない。

before/preview保存 → DOへprepare journal（revision付き）→ 最新本文再確認 → PUT 1回 → 再GET確認 → DO ack。
prepareが失敗/古いrevisionならWikiへ書き込まない。更新応答やackが失われても、次回はprepareの行と位置を確認して復旧する。
その間に新しい分類が保存された場合も、以前のprepareで移動した行だけを新しい選択へ移動できる。
古いackは新しいrevisionを上書きせず競合として報告する。繰り返しackは履歴を二重登録しない。
1件の競合や日付不明で他件の処理を停止しない。失敗はlastTriedAtで後ろへ回して次回も反映待ちに残す。
一度にqueue最大50件、ページ巡回5件。work/classificationsに対象別before/preview・結果・import-previewを保存する。
PR 1同様、Wiki APIが原子的条件付きPUTを保証しないため再GET〜PUT間の人間編集の完全ロックはできない。

## Dry Runと導入

- `CLASSIFIER_SYNC_ENABLED`既定false。未設定なら外部接続しない。
- trueでもDRY_RUN=false **かつ** VIDEO_WIKI_WRITE_ENABLED=trueになるまで読取専用。
- Dry RunはWiki、DO候補・分類・prepare/ack、scan cursor、cacheを変更しない。
  Wiki巡回・queue GET・必要詳細取得とローカルpreview生成のみ。未デプロイ時はモックfixtureで検証する。
- classification-state.jsonもPR 1のstate branchで保存。既存state branchに新ファイルがない場合だけ{}で移行。

承認後にのみ、Access/Secrets/routeを設定してWorkerをデプロイする。
まず`CLASSIFIER_SYNC_ENABLED=true`、VIDEO_WIKI_WRITE_ENABLED=falseのDry Runでimport-previewと移動diffを確認する。
候補importも書込みなので本番の初回登録は書込み承認後に行う。
編集者テスト→次tickの反映→取り消し→再反映→競合（Wikiで手動編集）の順で小規模確認してから運用する。
停止はCLASSIFIER_SYNC_ENABLED=false。編集画面のAccessポリシーも閉じられる。
DOは削除せず保持。SQLite DOのバックアップ/エクスポートはCloudflare側の運用手順で行う。

## ローカル検証

- `npm test`: Wiki移動/重複/日付/人間編集/分類修正/取り消し、prepare復旧、CAS、認証、SQLite SQLを検証。
- `npm run classifier:smoke`: bundle Dry Run + 実workerdで認証境界・SQLite保存・再起動後queueを検証。deployなし。
- `npm run test:browser`: ローカルテストUIとモックAPIでPC/スマートフォン操作。Chromiumを使用。
  `CHROMIUM_PATH`で実行ファイルを指定できる。テスト専用serverは127.0.0.1のみ。
- 本番APIへ書き込むテストや本番deployは実行しない。

## このPRでの検証記録

Nodeテスト60件、scheduler Worker 7件、PC/mobileのブラウザ2件、実workerdのSQLite再起動保存、
Wrangler bundle Dry Runを確認。認証/JWT偽装・CSRF・revision競合・重複・手動分類尊重・prepare復旧を含む。
読み取り専用の実Wiki Dry Runでは先頭5ページ中4ページを取得し、過去未分類13件を検出。
音海まいる/動画一覧は取得失敗として記録し継続。実メタデータに基づく1件の移動previewを生成し、
元行保持・年月・重複なしを確認。Wiki書込み・DO変更・本番deployはなし。
通常投稿セクションの子見出し（Shorts/未分類）の年foldを誤選択する既存の範囲探索を修正し、
分類修正・取り消しでも正しい投稿動画の年foldに入ることを回帰テストした。

## 未作成ページと巡回エラーの扱い

巡回中の**認証後のページGETがHTTP 404**を返した場合のみ、`WikiPageNotFoundError`
（`code=page_not_found`, `status=404`）として`scanSkipped`に記録する。
警告だけなら`failed=false`, `outcome=success_with_warnings`で同期を継続する。
未取得ページの空snapshotはimportしないため、DO内の`present`、分類revision、receipt、
prepare journal、履歴は変更しない。ページを自動作成したり、恒久除外リストを作ったりもしない。
73ページを1回最大5ページずつ巡回する方式とdisabledライバーの収集を維持し、
後から作成されたページも次の巡回で通常どおり再取得する。

401/403、429/5xx、認証API自体の404、タイムアウト、通信障害、JSON/`source`不正は
ページ不存在と区別して失敗にする。HTTPエラーの`reason=http_error`と数値`status`、
または`timeout` / `network_error` / `invalid_response` / `operation_failed`を安全に記録する。
外部のエラー本文・URL・資格情報・raw causeは記録しない。
共通HTTPの15秒timeout、非PUT最大3回と1秒/2秒backoff、PUT再送禁止、物理試行のquota計数は維持する。
この変更は既存の4xxリトライ回数も変更しない。

既存ページが空文字の`source`を持つ場合や未分類セクションがない場合は、正常な空snapshotとして扱う。
**取得できなかったページ**と**取得して対象行がないページ**は異なる。
分類適用時のGET失敗（404を含む）は警告に降格せず、その対象を`outcome=failed`として再試行待ちにする。
成功や`external`としてackしない。ほかの対象は継続する。

`work/classifications/report.json`は以下を区別する。

|項目|意味|
|---|---|
|`scanned`|正常取得したページ名|
|`scanSkipped`|`{page, reason: "page_not_found", status: 404}`の警告|
|`scanFailures`|`{page, reason, status?}`のエラー（従来のページ名配列から構造化）|
|`unclassifiedCount`|今回正常取得したページから収集した未分類件数（ページ内はvideoIdで重複除去）|
|`results`|各分類適用の結果。失敗時は安全な`reason` / `status?`も記録|
|`written`|少なくとも1件のWiki更新を更新後GETまで確認したか。未確認のPUT成功を保証する値ではない|
|`failed` / `outcome`|失敗有無と`success` / `success_with_warnings` / `failure`|

Actionsログにもページごとのwarning/errorと、取得・skip・失敗・収集件数・書込み確認・最終結果の
JSONサマリーを出す。分類結果の`outcome`を動画取得の`success`形式と混同しないよう、
共通起動側も各phaseの判定を尊重する。

実APIは2026-11-10の認証付き読取確認で、作成済みページのGETが200（`source`は文字列）、
ランダム名の未作成ページが404（JSONに`status` / `error`）であることを確認した。
[Wiki REST APIの案内](https://wikiwiki.jp/sample/REST%20API)はこの環境では403のため本文を参照できず、
非404の「ページなし」表現は確認していない。本文の文言やJSON内の`status`だけでは判定を広げない。

## 管理画面の連続操作（操作安定化PR）

保存APIと一覧取得を分離し、保存成功時にローカルキューから即座に除外する。
次ページはoffsetではなく並び順/keyのcursorで取得するため、分類で件数が減っても飛ばさない。
保留は現在の巡回の末尾で一度だけ再提示し、1件のみなら巡回を完了する。「更新」で次巡回を始める。
分類済みの修正は表示位置を維持。取り消しは最新保存revisionを使って対象カードを戻す。
一覧/件数の再取得に失敗しても保存済みの結果を失敗と表示しない。

クリック・矢印キー・スワイプは同じ保存処理を通り、保存中の重複要求を抑止する。
15秒の通信期限で解除し、応答消失時は対象revisionを再取得して保存結果を確認する。
409では最新カードを取得し、明示的な再操作を促す。400・401・403・500系・通信障害は別表示。
通常のカードは縦スクロールを許可し、下スワイプはカード内の明示した操作帯のみで受け付ける。

再現・回帰テストはローカルの実モデル/SQLite DO APIをブラウザから操作し、60件連続分類、
50件境界、保留、単独保留、修正、取消、二重操作、別タブ競合、通信/APIエラーを検証する。
ログには固定の操作種別、HTTP status、固定code、相関用requestIdだけを出し、
認証情報、Cookie/JWT、URL query、ページ本文、例外の生メッセージは出さない。

手動導入はレビュー/承認後に`npm ci`→`npm test`→`npm run test:browser`→
`npm run classifier:smoke`で確認し、既存Access/Secrets/DO bindingを維持して同じWorkerへ
`npx wrangler deploy --config ops/classifier/wrangler.jsonc`でUI/APIを同時更新する。
このPRでは本番deployしない。ロールバックは旧commitのWorker bundleを同じbindingへ戻す。
SQLテーブル・既存判断・履歴は削除しない。旧offset APIも残すためデータ移行は不要。

## Cloudflareを正本とする運用

[PR2の段階移管・新着直接登録・フラグ・Dry Run・導入/rollback](cloudflare-custody.md)を参照。
この機能を有効にした項目はWikiに元行がなくても管理画面に残り、保留/取消中はWikiへ掲載しない。
無効時の既存項目は従来どおりWikiを参照する。

## Access転送・通信エラーからの復帰

[確認できた原因、AJAX/CSRFヘッダー、再認証とrevision照合、診断方法](classifier-access-recovery.md)を参照。

## 認証失敗の原因分類

[Access側401とWorker認証の区別、公開鍵キャッシュ、不要な再認証の防止](classifier-auth-causes.md)を参照。

## Wiki APIの429と延期

[Wiki API間隔制御・Retry-After・再開とレポート](wiki-rate-limit.md)を参照。

## 公開日時が不明な動画

[非公開等の動画のメタデータ待ち・安全な再開と検証コード](classifier-metadata-wait.md)を参照。
