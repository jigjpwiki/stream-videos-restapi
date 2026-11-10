# 未分類動画をCloudflareで保管する（操作安定化PRに続くPR2）

通常の分類画面・認証・共通writerは維持し、未分類の正本をSQLite Durable Objectに移す。
Wikiには確定カテゴリだけを掲載する。既存73ページの過去行と、新着未確定動画の両方が対象。
このPRでは本番デプロイ、移管、Wiki書込み、Variables/Secrets変更を実施しない。

## フラグと既存運用への影響

|設定|既定値|用途|
|---|---|---|
|Worker `CUSTODY_ENABLED`|false|移管prepare/commitと新着直接登録のサーバー側ガード|
|Actions `CLASSIFIER_CUSTODY_ENABLED`|false|取り下げ・新着直接登録・Cloudflare正本のWiki掲載を許可|
|Actions `CLASSIFIER_CUSTODY_READ_ENABLED`|false|取下げ済み/分類済みIDの読取照合。切替後は停止・rollback時もtrueを維持|
|`CLASSIFIER_CUSTODY_BATCH_SIZE`|10|1回の移管上限（1〜50動画）|
|`CLASSIFIER_INGEST_BATCH_SIZE`|10|1ライバーの新着直接登録上限（1〜50動画）|
|`CLASSIFIER_SCAN_ALL`|false|Dry Run時のみ73ページ全件を巡回。liveは従来の最大5ページ|

既存のDRY_RUN/VIDEO_WIKI_WRITE_ENABLED/CLASSIFIER_SYNC_ENABLEDも必要。
両custodyフラグが無効なら既存Wiki経由の処理を維持する。READも既定falseなので、
新Workerの手動導入前にActionsだけが更新されても新APIは呼ばない。
既存の確定カテゴリ（ライブアーカイブ、タグで確定したShorts、長尺投稿）の処理は維持する。
スケジューラーToken/GitHub権限は拡張しない。内部連携は既存の分類専用Tokenで認証し、ブラウザへ渡さない。

## 既存行の段階的移管

1. 73人（disabledを含む）のWikiを5ページずつ読む。404は警告、その他の障害は失敗。
2. 対象見出しの動画行だけをimportする。元行の文字列、ID、ライバー/ページ、詳細メタデータを保持。
   既存のchoice/revision/receipt/分類prepare/historyは変更せず、既存行の版もoriginalLines等で保持する。
3. 対象を最新Wikiから再取得。重複、元行不一致、人間による分類との競合は保留する。
4. before/preview/diffを保存し、DOにcustody prepare（元行、before/after SHA-256）を保存。
   別GETで元行・metadata・revision・hashを照合し、キャッシュへ管理中IDもcheckpointする。
5. Wikiの本文が変わっていないことを再GETしてからPUTを1回だけ実行し、再GETで検証する。
   削除するのは対象動画の1行だけ。見出し、fold、他行、改行形式、手動編集箇所は維持する。
6. DOへcommitし再GET確認。元行とhistoryは残り、Wikiに行がなくてもキューに表示する。

SQLテーブルの削除/変更は不要。既存JSONにauthority/custody/originalLines等を追加し、
フィールドのない旧項目は従来の意味で扱う。原本は残し、通常importの空snapshotから
Cloudflare管理項目をpresent=falseにしない。Wikiの不存在だけでexternal判定もしない。

移管のprepareは分類のprepare journalと別フィールドなので、双方の復旧情報を保持できる。
PUT応答を失った場合は、prepareのafter hashとWikiの最新本文が一致するときだけcommitへ復旧する。
commit応答を失ってもDO内のcommitは維持され、再実行しても行を二重登録しない。
失敗したページの追加移管・分類適用を止め、動画取得側も未完了移管ページへの書込みを保留する。
prepared項目は通常ページ巡回と独立した最大5件の復旧キューでも再確認し、失敗日時で巡回する。

人間の追記等で全体hashが変わった場合は、自動でmerge/rollbackせず競合として保持する。
その場合でもWikiかDOに完全な行が残る。元Wikiの行を勝手に再生成したり、source全体を戻したりしない。
APIに原子的条件付きPUTの保証がないため、再GET〜PUTの間の極短い人間編集は完全ロックできない。

## 移管後の分類・修正・保留

- CF正本の未分類/保留はWikiに置かない。管理画面はWiki上のpresentとは独立して表示する。
- Shortsなら詳細publishedAtに基づくJST年/月、投稿ならJST年に保存元行を挿入する。
  元タイトル、URL、表示MM/DDを保持し、日付の年は推測しない。詳細不足は反映待ちで再取得する。
- 修正はシステムのreceipt/prepareと一致する行だけを移動する。
- 取消（未分類へ戻す）・保留はシステム掲載行だけを取り下げ、元行をDOに保持する。
- 人間が先に掲載/編集した場合はexternalとして尊重し、重複挿入や上書きをしない。
- 移管時点ですでに確定している判断はrevisionを変えずneedsPublicationで再掲載を予約する。
  Wiki更新後にreceiptを保存し、この予約を解除する。過去の履歴は削除しない。
- すでにexternalとして記録された人間分類と競合する既存行は、自動取下げせず確認対象にする。

## 新着直接登録・障害時再試行

動画取得時にCloudflare管理ID/既存判断を照合する。管理中ならWikiから消えていても自動再追加しない。
未確定動画はformatVideoLineで作る完全な行と取得詳細を直接DOへ登録し、別の読取で確認する。
同じpage+videoIdの再登録は既存判断/履歴を変更しない。

取得直後、外部変更の前に完全な動画詳細をpendingIngestion付きのローカルoutboxへcheckpointする。
既存の専用state branch保存により、失敗runでもoutboxを次runへ渡す。
CF障害・登録確認失敗・登録上限到達・Wiki障害の対象はsuccessにせず、最終成功日時を進めない。
次回はAPIの期間外になったoutbox動画も再生し、重複登録しない。
初回成功前の取得期間はfirstAttemptAtを基準として失敗期間を遡れるようにする。
管理中フラグは自動再取得の抑止だけに使い、分類処理のWiki掲載を妨げない。

## Dry Run・照合レポート

接続先/Secretsを安全な環境変数で指定して`npm run classifier:migration:dry`を実行する。
DRY_RUN=trueを強制し、73ページを全巡回する。CFのqueue読取、Wiki/必要なYouTube詳細取得だけを行い、
Wiki・DO・キャッシュ・scan cursor・state branchを変更しない。
取下げ差分はページごとにまとめて保存し、全件Dry Runのartifact量を抑える。
Dry Runの予定件数はWikiの候補数であり、実際のDO永続化の保証ではない。実移管は各件を別GETで検証する。

work/classifications/report.jsonのcustodyに予定・今回取下げ確認数・失敗・対象/hashを記録する。
liveではtotals.wikiTransfersCommitted（累積移管完了数）、preparedRemaining、newDirectCountをDOから取得し、
今回の取下げ数/復旧分と照合できる。APIに失敗した場合はimportFailed/recoveryFailed/ackFailed/statusFailedも区別する。
writtenは分類と移管の両方で検証済みPUTがあったかを表す（応答不明は成功と断定しない）。
移管のbefore/preview/diffはsource hash入りファイル名で保持し、再試行で最初のbeforeを消さない。
source/hash/行データはartifact/認証されたAPIに限定し、診断ログに本文や認証情報を出さない。

## 手動導入（レビュー・運用承認後）

1. PR1を先に導入。PR2のnpm test、npm run test:browser、npm run classifier:smokeを実行する。
2. 既存DOのバックアップ/履歴保持を確認し、CUSTODY_ENABLED=falseのままPR2 Workerを手動deployする。
   コマンドは`npx wrangler deploy --config ops/classifier/wrangler.jsonc`。同じDO binding/名前/v1 migrationを維持する。
3. CLASSIFIER_CUSTODY_READ_ENABLED=trueを設定して、新APIの読取と既存動画更新を確認する。
   その後、書込みガードを無効のまま全73ページのDry Runを行い、diff・対象数・404・エラーを確認する。
4. データ保全テストとDry Runが成功し、書込みの運用承認が得られた後だけ、
   WorkerのCUSTODY_ENABLED=true、ActionsのCLASSIFIER_CUSTODY_ENABLED=trueを設定する。
   VIDEO_WIKI_WRITE_ENABLED/DRY_RUNの既存ガードも確認。最初はCUSTODY_BATCH_SIZE=1〜数件で開始する。
5. 1件の移管→UIキュー→分類掲載→取消→再掲載、手動編集との競合を確認する。
   totalsとWiki差分、preparedRemaining、outbox失敗を観測し、上限を段階的に増やす。
   既定10件/run、動画の直接登録は10件/ライバー。Wiki/CFの負荷に応じて減らす。

無料枠は既存Workers/SQLite DO/GitHubを利用する。外部DBは追加しない。
YouTubeの分類用詳細は既存の最大50 IDs/3物理試行を維持。CFは新着のbatch lookup、件数制限、
移管/分類の上限で負荷を抑える。長期history/originalLinesとoutbox/backupの保存量、DO SQL読書き、
Workers/DO requests、Actions時間はダッシュボードで監視する。無料枠内を無条件には保証しない。

## 中断・ロールバック・手動復旧

CLASSIFIER_CUSTODY_ENABLED=falseで新しい移管とCF管理項目のWiki変更を停止する。
READ_ENABLEDはtrueを維持し、管理中IDの再取得照合を続ける。必要なら動画更新そのものも停止する。
DO、state branch、outbox、管理フラグ、before/preview/diffは削除しない。
**CFデータがある状態でCF対応前のWorkerへ戻さない。** 旧importはWiki不在をpresent=falseにするため、
CF対応Workerを保ったままフラグで止めるのが安全なrollback。

再開は同じDO/stateを使ってフラグを戻す。preparedは保存hashとWikiを照合して復旧する。
人間編集とのhash競合は自動解除しない。承認された担当者がbefore/preview/diff、現在本文、
DOのcustody.line/originalLines/receiptを比較し、対象行だけを最新本文へ復元する。
元行をWikiへ戻す場合も分類状態と重複を確認し、古いbefore全文で上書きしない。
CFを削除して元に戻す手順は提供しない。完全なコピーを保持したまま復旧する。

## このPRでの検証

ローカルSQLite DOを使い、移管→キュー維持→分類掲載→取消/修正/保留、保存確認失敗、
Wiki/CF応答消失、hash競合、途中失敗の再実行、outbox再生、再取得で未分類が復活しないことを検証。
実workerdの再起動後にもCF正本の行を保持することを確認する。
73ページのfixture Dry RunではDB/Wiki/state変更なし、ページ数と移管予定件数を照合する。

実Wikiの読取専用Dry Runでは73ページ中54取得・19未作成skip・その他の失敗0、未分類283件の
取下げpreviewを生成した。YouTube詳細は1リクエスト。Cloudflare queueはローカルの空fixtureを使い、
本番Cloudflareへの変更・永続化確認は実施していない。本番移管は未実施。

ページ別予定件数とhash、skip一覧は[custody-dry-run-summary.json](custody-dry-run-summary.json)に記録。
これは当日の読取スナップショットであり、運用直前には最新本文でDry Runをやり直す。
