# 共通10分起動と動画更新（PR 1）

Cloudflareの既存 `sync-stream-schedule.yml` dispatch、Worker、Actions用Tokenを再利用する。
Workerの権限変更、Cloudflare deploy、本番Wikiへの書込みはこの変更では行わない。
1 run内でschedule → classification（PR 1では無処理の拡張点）→ due videosを直列に処理する。
各phaseの例外は他phaseを停止させず、失敗はworkflowの終了コードに反映する。
スケジュールのマーカー、WIKI_WRITE_ENABLED、Dry Run、再取得ガードを維持する。

## 人数と既定値

`src/config/livers.json` の73人中52人がenabled、21人がdisabled（テストで固定確認）。
BATCH_SIZE=5、DAYS_BACK=14、VIDEO_INTERVAL_HOURS=2を全入口で統一。
2時間経過したライバーのみ、最も長く試行していない順に最大5人取得。
未取得・失敗も期限対象。試行日時で公平に並べるので恒久的なエラーが他者を占有しない。
失敗時にlastSuccessAtは進めず、正常者が期限内なら次の10分起動で再試行する。
52人初回巡回には11 tick（約110分）が必要。毎回全員を取得しない。
旧lastIndexは移行時に無視し、証拠のない成功日時を生成しない。

## APIクォータ

従来search.listは100 units/request、videos.listは1。52人×12回/日なら最低63,024 units/日。
旧cron実効5人×12回でも最低6,060、手動既定30人なら36,360（他ジョブ・追加pageは別）。
新方式はchannels.listでuploads ID取得（1）、playlistItems.listで一覧（1/page）、videos.list（1/50件）。
52人×12巡回×3 = 約1,872 units/日（各一覧・詳細1page時）。
10分tickあたり全動画取得の物理HTTP試行を最大40 unitsに制限（再試行も計数）、最大5,760/日。
移行中の旧cron分は最大480/日が別に必要。配信スケジュールのvideos.listは別枠。
通常10,000/日の標準枠を前提とする計算であり、実プロジェクトの残量を取得するAPIではない。
Google Cloud Consoleで他利用者も含む日次実績を確認する。report.quota.usedは動画側の実試行数。
予算不足・20page上限・API不正応答は対象を失敗扱いにして成功watermarkを維持する。
長期障害からの復旧は前回成功日時−14日まで遡る。uploadsは公開日時のoverlapを再取得し、
配信中・開始前を除外する既存分類を維持。長期配信（14日超）やplaylist掲載遅延はDAYS_BACK拡大で再走査する。

## Dry Run・書き込み

`npm run update:dry` / `npm run sync:dry` はデータ・Wikiとも不変。
動画書込みはDRY_RUN=false **かつ** VIDEO_WIKI_WRITE_ENABLED=trueの両方が必要。
統合の周期実行には従来WIKI_WRITE_ENABLEDもtrueである必要がある。
UNIFIED_VIDEOS_ENABLEDがtrueのとき統合runで動画を処理（既定false、段階移行用）。
`npm run update`単体も既定Dry Run。APIキー、Wiki認証はサーバー側のみ。
work/videosに対象別before/preview.wikiとreport.json、work/syncに全phase結果を保存。
reportには今回の取得結果、全channelの最終試行・最終成功・状態・連続失敗数を保持。
Dry Runの成功はシミュレーションであり永続化されない。

Wiki本文を正として全sectionで重複確認。古いcache hitを編集の拒否条件にしない。
人間が移動済みの動画を再分類しない。分類ロジックとWikiフォーマッターは変更しない。
更新直前に最新本文を再取得、不一致ならPUTを中止。PUTは応答不明でも自動再送しない。
更新後に本文を確認し、一部失敗は対象の成功watermarkを進めない。
次回はWikiを再読して既存動画をスキップするので応答喪失から復旧できる。
APIに原子的な条件付きPUTの保証はないため、再GET〜PUT間の人間編集を完全排除するロックではない。
before/previewを必ず先に保存し、競合・検証失敗時は成果物とWiki履歴で確認する。

## Actions・永続化

両workflowは同じconcurrency group `wiki-writer`（cancel=false）で排他する。
PRテストだけはPR別group。restore/saveするActions cacheは使わない。
キャッシュと状態は専用 `automation/wiki-sync-state` ブランチへCAS pushで保存する。
mainへのbot commitはしない。共通load/saveスクリプトがdataのJSONだけを復元し、コードをcheckoutしない。
初回だけmainに残る旧cache/stateを取り込み、以後は専用ブランチを正とする。
状態保存は失敗runでも実行し、branch競合は可視化して上書きしない。
Wiki成功後〜state保存前に失敗しても、再取得と本文重複確認で安全に再実行する。
ローカルJSONはtemp+renameで保存。Actions tokenのContents writeはstate branch用にのみ使用する。
スケジューラーTokenは従来どおりActions read/write、Contents write不要。

## 切替（マージ後の承認された運用作業）

1. `UNIFIED_VIDEOS_ENABLED=true`、`VIDEO_WIKI_WRITE_ENABLED=false`で統合Dry Runを確認する。
   旧2時間cronはまだ残す。状態を進めないため同じ対象が選ばれるのはDry Runの正常動作。
2. preview、人数、API実績、欠落section、対象別失敗、state branch保存テストを確認。
3. 書込みの別途承認後、既存WIKI_WRITE_ENABLEDを確認しVIDEO_WIKI_WRITE_ENABLED=trueにする。
4. 統合runで11 tick以上を観測。正常対象の成功日時更新・重複なし・分類維持・失敗再試行を確認。
5. **動作確認後にのみ** `LEGACY_VIDEO_CRON_DISABLED=true` を設定し旧cronの実処理を停止する。
   このPRでは変数を変更しない。物理cron削除はその後の運用PRで可能。
6. rollbackはUNIFIED_VIDEOS_ENABLED=false、LEGACY_VIDEO_CRON_DISABLED=false。
   専用state branchと共通排他・ガードは維持。失敗時もmainへstateを戻さない。

## 検証

`npm test`、`npm run schedule:demo`。動画テストは外部APIなしで実フォーマッターを通すDry Run、
重複・人間分類維持・再取得競合・保存失敗・応答喪失復旧・部分失敗・期限・quotaを検証する。
state testは一時ローカルbare repositoryでroundtrip、main不変、CAS競合を検証する。
