# Wiki APIの429と分類同期の延期

## 調査結果と適用範囲

利用者からActions #139〜#142で分類200件中179件成功、21件がWiki HTTP 429、
#142の2件が#143で復旧したと報告された。これらは利用者の観測値である。
本環境では該当artifactのダウンロードが403となり、各リクエストの時刻やRetry-Afterは確認できなかった。
[公式REST API案内](https://wikiwiki.jp/sample/REST%20API)とAPIルートも403で、
公式の秒間/分間上限は確認できていない。以下の1秒は**APIの制限値ではなく、クライアント側の保守的な間隔設定**であり、429解消を保証する値ではない。
既存backoffの最小値1秒を成功時の通信にも適用してバーストを避ける初期方針とした。

変更前のコードは分類1件ごとに本文GET、競合確認GET、PUT、検証GETの通常4回。
さらに5ページ巡回と認証があり、成功時の待機はなかった。
最大50件の適用バッチだけでも通常200回（5ページ巡回・認証・移管・他フェーズは別）となる。
GETエラーは1秒/2秒後に最大3回試行し、429でも次の動画を継続していた。
既存ログには物理リクエストの時刻/操作別429がなく、実測RPSやサーバーの制限方式は断定できない。

## 動作

- Wiki専用transportで認証・GET・PUTの物理試行を直列化し、開始間隔を最低1秒にする。
  統合同期の配信スケジュール、分類同期、通常動画更新へ同じgateを明示的に渡して共有する。
  YouTube/Twitch/Jigduleのtransportとクォータ計数にはこの待機を適用しない。
- GET（認証の既存再試行も含む）は最大3試行。通常エラーの1秒/2秒backoffと15秒通信期限を維持。
- 429のRetry-Afterは秒数またはHTTP日付を解釈し、指定より早く再試行しない。
  欠落/不正値は既存のbackoffを使う。生のヘッダーや本文は記録しない。
- 最初の短い429は待機後にGETを再試行可能。連続2回の429、または5秒を超える待機は
  circuitを開いてその実行の残りのWiki通信を止める。連続429には最低30秒のcooldownを設定する。
  5秒/30秒はActionsの長時間占有と集中再試行を避けるローカル方針で、サーバーのquotaではない。
- PUTは429/5xx/timeout/応答消失を含め**自動再送しない**。
  応答が不明なPUTは検証GETで完全なafter本文と一致した場合だけ成功とする。
  検証も429なら未確認のまま延期し、prepare journalを保持する。
  次回も最新GETからreceipt/prepare照合で復旧するので、同じ動画を重複挿入しない。
- 分類の巡回/適用/移管で429となった対象は失敗ackや成功ackを送らず、未適用revisionのまま保留する。
  同期側でも連続した429対象を検出したら残件を延期する。
  正常に検証済みの別対象のreceiptは通常どおりackする。
- cooldown期限は既存の`data/classification-state.json`の追加フィールド`wikiRetryAt`に保存する。
  統合同期は次回、スケジュールのWiki通信より前に復元する。
  import/ackに別の障害があってもcooldownを保存し、巡回cursorは進めない。
  期限経過後の新プロセスは通常の巡回を再開する。永続的な除外は行わない。
- Dry Runはプレビュー/レポートのみ。Wiki PUT、分類DB、receipt/history/cache/cursor/cooldownの永続状態を変更しない。

## レポートと診断

`work/classifications/report.json`の`scanned`/`scanSkipped`/`scanFailures`に加え、
`scanDeferred`と`results[].outcome=deferred`、移管の`custody.results[].outcome=deferred`を記録する。
`deferred`は巡回ページと適用/移管対象を合算した延期操作数であり、動画の一意件数ではない。
`complete=false`、`outcome=deferred`は今回の取得バッチに未処理があることを示す。
真の失敗が併存すれば`failed=true/outcome=failure`を優先する。
429だけの延期はActionsをfailureにせず、構造化ログとartifactで未完了を示す。全件成功とは表示しない。

HTTP診断は固定のphase/operation、status、attempt、deferred、数値retryAfterMsのみ。
operationは`auth/get/conflict_get/put/verify_get`を区別する。
429後にGET再試行が成功した場合も、発生した429はログに残る。
`written`は検証済みの書き込み、`writeAttempted`はPUT試行あり、
`writeUnverified`はPUT後のGETが失敗して反映をまだ確認できないことを示す。
後者がtrueの場合、written=falseでも「何も書かれていない」と解釈しない。
認証情報、トークン、本文、URL/query、raw例外は出力しない。

## 検証と運用

仮想時計と偽APIで間隔、同時呼び出し、Retry-After秒数/日付、連続429、長期延期、
GET/PUT/検証GETごとの診断、期限前の無通信、再開、PUT応答消失、未確認の再実行を検証する。
実SQLiteのClassifierテストで判断・revision・receipt・prepare journal・履歴の保持と重複なしを確認する。
既存の配信マーカー/書き込みガード、通常動画の取得ウォーターマーク/クォータ、Dry Runテストも維持する。

1秒間隔により正常時の実行時間は増える（適用50件の200試行なら待機の下限は約199秒）。
18分の統合ジョブ期限は変更しない。移管・リトライ等を含め時間が不足する場合はartifactから評価する。
共有gateはプロセス内の制御であり、外部編集者/別プロセスの合算quotaは制御できない。
既存のActions `wiki-writer` concurrencyを維持する。
単独の旧動画ワークフローもプロセス内pacingを使うが、統合同期のcooldown復元は`runSync`経由で行う。

本番への書き込み・Cloudflare変更は本作業で実施しない。
導入はレビュー後にmainへのマージでActions側コードを更新するだけで、Workerデプロイ/Secrets変更は不要。
まず既存のDry Runでreportとログを確認する。ロールバックはこのPRをrevertし、
既存の分類DB・state・prepare journalは削除しない。追加フィールドは旧コードが無視する。

## 追加レビュー: フェーズ間の延期共有

`runSync`が1つのgateを生成して3フェーズへ渡す。スケジュールのWiki HTTPエラーは型を保持し、
429だけを`outcome=deferred/failed=false/complete=false`としてスケジュール自身のreportへ保存する。
401/403/5xxやWiki以外のAPI障害は引き続き失敗とし、統合reportに安全なreason/statusを記録する。

分類はフェーズ開始時にも共有gateのcooldownを確認する。動画更新は各対象の取得開始前に確認し、
cooldown中はYouTube取得やWiki呼び出しを始めず対象を延期する。
更新中にWiki 429が伝播した対象も延期とし、lastSuccessAt/lastAttemptAt/firstAttemptAt/failures/statusは
開始前の値を保持する。取得済みのoutbox/cacheは既存の安全なcheckpointに残し、再試行可能にする。
後続ライバーに通常の失敗履歴を追加しない。

分類が無効/途中失敗の場合や動画フェーズで初めて発生したcooldownも、統合処理の最後に期限を保存する。
最新のclassification-stateを再読込してwikiRetryAtだけを追加し、分類が更新したcursor等を上書きしない。
Dry Runや既存の書き込みガードが無効の場合は保存しない。保存自体の失敗も真のエラーとして報告する。

統合reportの`summary`はfailed/deferred/complete/outcomeを明示する。
延期だけならdeferred、実エラーが併存すればfailureを優先し、deferred=trueも維持する。
フェーズを丸ごと打ち切ることはせず、独立したAPI/設定/認証の真のエラーを隠さない。
動画reportでも延期と失敗の件数を分け、先行対象で起きた真の失敗を後のcooldownで消さない。

追加の統合回帰テストは実際のスケジュール/分類/動画関数と偽transport・時計を組み合わせ、
スケジュールGET 429→分類/動画延期、分類検証GET 429→動画延期、動画起点の429、
401/403/503、延期と真のエラーの混在、cooldown保存失敗、Dry Runを検証する。
PUT再送禁止・書き込みガード・分類履歴保護は従来のテストも維持する。
