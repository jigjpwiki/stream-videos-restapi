# 配信スケジュール自動同期 v1

じぐじゅーるの既存 `https://www.jigdule.jp/data/{youtube,twitch}.json` を再利用する独立ジョブ。YouTube動画収集・個人Wiki更新・キャッシュには接続しない。変更した既存コードは `src/index.js` のキー値ログ削除のみ。既存ワークフローは変更しない。

## 調査結果と前提

- 実JSONの安定識別子は `youtubeid`（チャンネルID）、`twitchid`（ログイン）。過去のTwitchアーカイブには `url` / `type` がないため、アーカイブ除外を先に行う。
- Wiki REST APIを認証付きで**読み取りのみ**実行し、現行スケジュール本文、メニューの顔画像パス・出現順を確認。メニューの `#null` 内にある人物順も設定根拠に含む。92件のプラットフォーム別対応を登録。未登録人物はデータの名前のみで表示する。名前の類似から画像を推測しない。
- 現行ページにマーカーは未設置。既存の include はメニューに設置済みだったが、この機能はメニューを編集しない。
- YouTubeは全候補を50件ずつ再確認し、延期も反映する。取得されない動画IDは削除・非公開として除外する。チャンネルID不一致・不正応答は全更新を中止する。
- 予約の非ゼロ動画尺はプレミア等として除外する。実APIでは予約ライブのduration自体が省略されるため、省略は正常として扱う。公開APIにはプレミア専用判別フラグがないため、上流 `type=stream` とYouTubeの状態・尺情報に依存する。実データで誤分類が判明した場合は書き込みを止めて対応する。
- TwitchはJSON内の有効な配信ログインのみ照合する。JSONにない新規ライブを独自探索しない。last_updated.jsonだけを鮮度の根拠にしない。

## ローカル検証（Node.js 22以上 / git）

追加依存なし。テスト・デモにSecrets不要。

```sh
npm test
npm run schedule:demo
cat work/schedule/preview.wiki
cat work/schedule/preview.diff
cat work/schedule/report.json
```

デモは固定日時と合成配信データを使い、外部通信・本番書き込みを一切しない。顔画像あり・なし、両プラットフォームの表示例は [stream-schedule-demo.wiki](stream-schedule-demo.wiki) を参照。デモは実際の配信状況ではない。

実データDry Runは下記。資格情報は環境変数で設定し、コマンドや成果物へ値を書かない。

```sh
npm run schedule:dry
# 出力先変更
DRY_RUN=true node src/schedule/index.js --output work/review
```

実ページにマーカーがない間は安全に失敗する。ローカルでのdotenv自動読込は行わない。環境プロキシが必要なNode.js 24のクラウド環境では `NODE_USE_ENV_PROXY=1` を指定する（通常のGitHub Actionsには不要）。

## GitHub Secrets / Variables

|種別|名前|内容|
|---|---|---|
|Secret|`WIKI_API_BASE_URL`|`https://api.wikiwiki.jp/jigjp`（他Wiki拒否）|
|Secret|`WIKI_PASSWORD`|Wiki REST API認証用パスワード|
|Secret|`YOUTUBE_API_KEY`|YouTube Data API v3用。API制限・実行元制限を確認|
|Secret|`TWITCH_CLIENT_ID`|TwitchアプリのクライアントID|
|Secret|`TWITCH_CLIENT_SECRET`|Twitchアプリのクライアントシークレット|
|Variable|`WIKI_WRITE_ENABLED`|初期値は未設定または`false`。有効化時のみ`true`|

環境内に資格情報があっても、GitHub Secretsの登録済みを意味しない。Twitch対象がある回はTwitch資格情報が必要。GitHub組み込みトークンは `contents: read` のみで十分。Wiki資格情報はPRイベントへ渡さない。

## 初回マーカー設置と有効化

1. このPRをレビュー・マージするまでは本番を変更しない。本実装作業ではmainへ直接コミット・マージしない。
2. 管理者が対象ページの最新ソースを保存し、[マーカー最小差分](stream-schedule-markers.diff)を確認する。[マーカー設置後の参考全文](stream-schedule-markers.wiki)は調査時点のスナップショットであり、最新ページを丸ごと置換しない。
3. 「現在配信中」の内側cssboxで既存の調整中表示を `// JIGWIKI_LIVE_BEGIN` と `// JIGWIKI_LIVE_END` で囲む。「このあと配信」も `// JIGWIKI_UPCOMING_BEGIN` と `// JIGWIKI_UPCOMING_END` で囲む。各コメントは単独行、各1回、上記順序。本文以外は変更しない。
4. Wikiのプレビューで `#include`、`#cssbox`、`#responsive_layout_item(12)`、全閉じ括弧、顔画像・リンクを確認後、管理者がマーカー設置を保存する。今回この操作は実施しない。
5. 上記Secretsを登録し、書き込みVariableは無効のまま新ワークフロー `Sync stream schedule` を手動実行、`dry_run=true` を指定する。テスト成功と `stream-schedule-preview-<run_id>` 成果物の `preview.wiki`、`preview.diff` を確認する。
6. 生成ソースをWikiのプレビューで確認する。リポジトリの構文テストだけでは実Wikiの描画は確認できない。タイトルやコラボがなく、各最大10行、名前が配信URLへリンクすることを確認する。
7. 管理者がRepository Variable `WIKI_WRITE_ENABLED=true` を設定する。手動で `dry_run=false` を指定して1回実行、反映とログを確認する。以後毎時03/13/23/33/43/53分（UTC）の独立scheduleが実行される。手動Dry RunはVariableがtrueでも書き込まない。
8. 停止はVariableを `false` にする。緊急時はワークフローをDisableする。未設定では定期実行もDry Runにとどまる。

## 障害・ログ・復旧

APIは15秒タイムアウト、最大3回・1秒/2秒バックオフ。PUTは応答喪失時の二重適用を避けて再試行しない。JSON・状態確認・認証失敗を正常0件に変換しない。GitHub Actionsのジョブ全体は8分で停止しconcurrencyで同時実行を抑制する。既存の動画更新とのconcurrencyは共有しないので、Wiki全体のAPI利用量は管理者が合算確認する。過負荷・429が続けば頻度を下げる。

ログと `report.json` は処理日時（UTC ISO）、媒体別取得件数、API成功状況、除外理由、live/upcoming件数、差分・書き込み有無を記録する。失敗時はAPI名または固定エラーのみを記録し、遠隔応答本文や資格情報を表示しない。`written=true` の実行時刻が最終成功時刻。変更なしは `changed=false`。失敗時のページは前回表示が残り得る。10分間隔は遅延・欠落し得るベストエフォート。

更新前 `before.wiki`、更新案 `preview.wiki`、差分、報告を7日間Actions成果物として保存する。秘密値は含めない。書き込み前に再GETして完全一致を要求し、書き込み後もGETして検証するが、GETとPUTは原子的ではなく競合の余地が残る。

復旧時はまず書き込みを無効化し、該当実行の `before.wiki` と現在の最新ソースを比較する。管理者が対象2区間だけを戻し、他編集者の変更を残す。自動復旧やページ全文の無条件上書きはしない。障害解消後は手動Dry Run→成果物確認→再有効化する。

既存キー値ログを削除した。過去ログが実際にキー値を含んだかは未調査のため、管理者は公開済みActionsログを確認し、露出があればキーをローテーション・旧ログを削除する。既存クライアントのリモートエラー本文も秘密値を含み得るため、本文ログを除去する（通信・更新ロジックは変えない）。

## この変更で実施した検証

- モック単体・結合テスト、デモCLI Dry Runを実施。テストは外部API・本番Wikiへ接続しない。
- 公開JSONとYouTube実APIを読み取り、手元のマーカー付きページを使うDry Runで173件/2件を入力、live 4件・upcoming 5件を生成、`written=false` を確認した（2026-11-09 01:52 JST）。[実データ生成ソース](stream-schedule-real-preview.wiki)と[報告](stream-schedule-real-preview-report.json)はその時点のスナップショット。Twitchの実データ対象はアーカイブのみだったため、Twitch状態APIの実通信はこの回には発生していない。Twitchはモックで検証した。
- Wiki実ページのマーカー未設置時はDry Runも停止することを確認。本番WikiのPUT・実Wikiプレビューの保存・マーカー追加は実施していない。管理者の目視プレビューは有効化前に必要。
- 既存動画ジョブを本番実行する回帰試験はWiki編集を伴うため実施しない。既存ワークフロー・動画更新ジョブ・整形・キャッシュ処理の差分なし、既存サービスはエラーログの本文除去のみであることを確認した。

## 「このあと配信」の12時間ウィンドウ

更新時点を基準に、開始日時が「現在以上、12時間後以下」の確認済み配信予定を、開始時刻の早い順で最大10件表示する。
ちょうど現在/12時間後は含み、現在より前・12時間より先は除外する。暦日では絞らず、JSTの日付・月・年をまたいでも同じ条件を使う。
対象が10件未満でも範囲外の予定で補充しない。同時刻は既存のメニュー順、platform/id順で安定化する。
時刻比較は絶対時刻（ミリ秒）で行い、Wikiの時刻表示は既存のJST「00時30分～」等のままとする。

例: 11月14日23:45 JSTの更新では、翌00:30、08:00、11:45を含み、12:00や当日23:30は除外する。
各実行で注入されたnowからウィンドウを計算し直すため、定期実行ごとに範囲が移動する。
旧仕様の「当日の未開始予定を予定時刻後も[開始待ち]で残す」扱いは、この変更で終了する。
予定時刻を過ぎたupcomingを自動的に配信中へ移すことはなく、APIでliveを確認したものだけを既存どおり表示する。
API上の延期は再確認後の新しい開始日時で判定する。終了/キャンセルを予定時刻だけで推測しない。

取得側はJigduleのプラットフォーム別JSON全体を取得し、normalize/verify段階では当日限定の切り捨てを行っていない。
そのため、日付をまたぐ予定を取得するための新しいリクエストやエンドポイントは不要。
classifyの時間条件はプラットフォーム共通であり、テストはYouTube/Twitch両方の予定候補を確認する。
実APIの確認方法は維持し、YouTubeはvideos.listのscheduledStartTime、Twitchは従来どおりHelix streamsでliveを確認する。
Twitchの新しい予定取得APIや、未確認の予定を掲載する経路は追加しない。

テストは固定nowで日付/月/年/うるう日の越境、境界±1ms、10件超過/少数/0件、同時刻順、実行間の範囲移動を確認する。
偽APIを使う取得〜WikiプレビューのDry Runでも、翌日の入力とAPIで翌日に延期された入力が正しく残ることを検証する。
配信中のソート・件数・記法、Wikiマーカー外の保護、競合確認、差分更新、429制御、書き込みガードは変更しない。

レビュー後のマージでActionsのコードが更新される。Workerや設定の変更は不要。本作業では本番Wiki更新・デプロイを行わない。
ロールバックはこの変更をrevertする。Wikiや分類DB・キャッシュの初期化は不要。
