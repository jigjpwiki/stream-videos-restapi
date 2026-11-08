# 任意導入: Cloudflare Cron → GitHub Actions

[調査結果と第1段階](INVESTIGATION.md)。既存のActionsを実行基盤とし、Workerは起動と監視だけを担当する。各リポジトリのWorker/DO/Tokenは独立させる。無料枠のCronとSQLite Durable Objectを利用する設計。無料枠超過時の停止やGitHub API/Actions制限は別途監視する。コードは依存パッケージなし。

## 動作

- cronはUTCで10分ごと。単一名のDurable Objectがリクエストを直列化し、起動試行slot・時刻を永続化する。再配信、隣接slot境界も周期境界の最大1分の遅延差を許容しつつ最低9分あけ、POST前に記録する。POST timeout/403/429は即再試行せず次周期に回す。
- mainの当該workflowの最新100runに未完了/直近起動があれば追加起動しない。通常手動やpushも頻度抑制に含める。古いactive runが100件外になる場合や確認後の手動起動とのraceは、この確認だけでは排除できないため、既存のActions concurrencyを最終的なwriter排他に使う。厳密な分散exactly-onceは保証しない。
- `SCHEDULE_DRIVER=cloudflare`で標準scheduleの実処理をskipし、外部の`periodic=true`を許可。未設定/`github`は逆。両方有効でも二つの定期収集経路を動かさない。通常手動は維持。手動の繰り返し実行までレート制限する仕組みではない。
- 外部`periodic=true`はscheduleと同じDRY_RUN判定を使う。`WIKI_WRITE_ENABLED == 'true'`の場合だけ書込み可能で、それ以外はdry-run。処理本体のwriteEnabledチェックも維持する。手動のdry_run既定trueはそのまま。既存Update Videosは別用途として変更せず、同じYouTube APIプロジェクトの合計クォータに含める。
- APIエラー/残クォータ100未満ではfail closed。各GitHub呼出しは3秒timeout（DO直列区間の30秒上限内に収める）。1 tickあたりGET 1〜6回+POST最大1回、1日最大144 dispatch。2つを合算しても定常時GitHubリクエストは概ね数十回/時程度（監視頻度を含めて算定）。YouTube等は既存の定期間隔・キャッシュを維持し、GitHub/nativeとの二重収集を抑制する。欠落が解消すれば実際の収集回数は本来の予定数まで増えるため、既存APIの合計日次使用量を切替前後で確認する。新たな探索や自動リトライは増やさない。

## 導入手順（マージ後、別途承認された運用作業）

1. まず第1段階を観測。第2段階が必要な場合のみ実施する。両PRを一括で切り替える必要はない。
2. Cloudflare Workers Free/SQLite DO対応と残枠を確認。`wrangler.jsonc`の固定repo/workflow/main、cron、INTERVAL_MINUTESをレビュー。`ENABLED=false`のまま準備する。
3. GitHub fine-grained PATを対象リポジトリ1つだけ、Actions read/write + Metadata read、短い有効期限で発行する。管理者権限やContents writeはWorkerに不要。GitHub Appの場合は短期installation tokenを更新する別設計が必要で、期限付きtokenを放置しない。
4. CloudflareのSecrets UI、または`wrangler secret put GITHUB_TOKEN --config ops/scheduler/wrangler.jsonc`の対話入力で保存。`HEALTH_TOKEN`もランダムな別Secretとして保存。値をソース、vars、ログ、チャットに入れない。既存のYouTube/Twitch/Wiki SecretsはGitHubにのみ残す。
5. 管理者がGitHub Actions repository variable `SCHEDULE_DRIVER=cloudflare`を設定。進行中/待機中の旧定期処理が完了するまで待つ。Wikiでは`WIKI_WRITE_ENABLED`を変更しない。
6. `ENABLED=true`に設定してCloudflareへデプロイ（例: `wrangler deploy --config ops/scheduler/wrangler.jsonc`）。このPRでは実行しない。Cloudflare Cron設定の反映には時間がかかる場合がある。worker.dev URLはヘルスチェックのみ公開する。
7. 3周期以内に`[periodic]` runと`sync` job成功、収集/preview成果物、API使用量を確認。Wikiのjob成功はdry-runを含むため、実書込み有無はpreview/artifactと既存安全制御で確認する。
8. 独立した外部監視から5分ごとに`GET https://<worker>/health`、`Authorization: Bearer <HEALTH_TOKEN>`をSecretヘッダーで送信し、非200/timeoutで通知する。監視サービスの設定は別途必要。Worker内だけの監視ではCron停止を検知できない。

## 成功日時と停止検知

認証付き`/health`は`last_success.completed_at`（UTC）、run URL/id、last_tick、last_errorを返す。workflow全体のsuccessだけでなく実際の`sync` job成功を確認し、実行元gateでskipされたrunを成功扱いしない。最新100runのうち直近5件の成功定期runまで確認し、見つからなければ永続化済み日時を使う（未観測ならnull）。失敗履歴はlast_errorとして保持する。

最終成功またはCron受信が3周期（30分）を超えるとHTTP 503。起動直後も成功未観測なら503。GitHub認証失効・APIエラーも503。手動成功のみでは定期系の異常を隠さない。Workerのtickは構造化ログを出すが、通知の実配送は外部監視側で設定・テストする。Worker自体の停止、無料枠到達、token失効も監視対象になる。

## ロールバック

WorkerをENABLED=false（またはCron削除）にして停止 → 実行中/待機中の外部起動Actions完了を待つ → `SCHEDULE_DRIVER=github`または削除。既存workflowをdisableしない。Token漏えい時はGitHubで失効しCloudflare Secretを更新。履歴とDO stateは監視調査用に残す。

## ローカル検証

`node --test ops/scheduler/worker.test.mjs`（ネットワークはモック）。重複/境界間隔/手動との競合/POST応答不明/クォータ/skip成功判定/停止/認証を確認する。`wrangler deploy --dry-run --config ops/scheduler/wrangler.jsonc`でbundle/config検証。本番Cron、GitHub dispatch、Wiki書込みをテスト中に実行しない。
