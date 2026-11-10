# 非公開等で公開日時を取得できない動画の分類同期

## #158の調査（2026-11-10）

利用者から#157/#158で鈴木沙透の2動画（revision 3）がoperation_failedになったと報告された。
本環境では#158 Artifactの取得が403となったため、Artifact内容の独立確認はできなかった。
代わりに次の読み取り専用調査を行った。本番Wiki/分類DBの書き込みはしていない。

|動画ID|mainと最新永続状態ブランチのキャッシュ|現行Wikiの出現数/未分類行数|YouTube videos.list|
|---|---|---|---|
|3FpJSQazDFM|publishedAtなし。登録日時はある|1 / 1|正常応答に含まれない|
|OO_EFLePEMM|publishedAtなし。登録日時はある|1 / 1|正常応答に含まれない|

Wiki本文には投稿動画/Shorts動画の見出しも存在した。
現行本文を公開日時のないメタデータでreconcileすると、両方とも公開日時検証で停止する。
旧コードの`Verified publication date required`が汎用operation_failedへ変換される経路と一致する。
重複ではなく、公開日時を持たずに年月別セクションへ移動しようとすることが確認できた停止条件である。
利用者は動画が非公開になったことを確認済み。APIから返らない理由は非公開/削除/参照不能等を区別できないため、
システム上は「APIの正常応答に含まれない」とだけ記録し、非公開と断定しない。
過去のWorker内部の全メタデータや#158時点の本文を直接閲覧したとの主張ではない。

## メタデータの扱い

- 既存キャッシュ、pendingのWorkerメタデータ、追加のYouTube詳細を順にマージする。
  custodyの最新item再取得で初めて有効日時を確認した場合も利用する。
- publishedAtは明示的なISO timestampと暦日を検証する。新しい欠落/null/不正値で、過去の有効日時を消さない。
  Workerの再importも同じマージ関数を使い、通常候補/Cloudflare管理候補のどちらも保護する。
- registeredAt、Wikiの月日、現在年、receiptの配置先から公開日時を作らない。
- 正式なYouTube詳細を追加取得した場合は、書き込みガードが有効な実行で既存の動画キャッシュへ保存する。
  巡回5ページ外のpending候補にも対応し、不完全なページsnapshotをWorkerへ送ってほかの行を消さない。
  巡回ページの詳細は従来どおりimportされる。キャッシュ保存失敗も真の失敗として報告し、その実行のWiki適用/取り下げは停止する。
- 動画が正常API応答に含まれず、どこにも有効日時がない場合は`outcome=metadata_waiting`、
  `reason=missing_publication_date`、`availability=not_returned`とする。
  API 401/429/5xx・通信障害・不正応答はmetadataFailures/metadataErrorとmetadata_fetch_failedで区別する。
  それらを非公開や正常な空結果に変換しない。

## 安全性と再開

メタデータ待ちだけではfailed=trueにせず、reportはmetadataWaiting件数、complete=false、outcome=deferredを示す。
別の真のエラーがあればfailureを優先する。成功/失敗ackを送らず、分類判断、revision、appliedRevision、
receipt、prepare journal、履歴を保持する。候補はpendingに残り、次回も通常の上限付き取得対象となる。
後日正式な情報を取得できれば同じrevisionを自動反映する。失敗したまま恒久除外しない。
Workerのスキーマや新しい認証権限は追加しない。待ち状態は同期reportに記録する。

不明日時の既存Wiki行は移動/削除しない。custody機能が有効でも、日時不明の取り下げは延期する。
Dry Runの移管previewも不明日時の行を取り下げ対象にしない。
人間が先に分類/編集した行は従来どおり尊重し、未知日時だけを理由にexternalとackしない。
最新本文の再GET、競合確認、prepare/receipt照合、PUTの無条件再送禁止、429 gateは変更しない。
APIが返らなくても、有効な過去日時がある動画はその日時で既存行を保って正しい年月へ移動できる。
タイトルのない部分メタデータでも、保存される行は元のWiki行を維持する。

## 固定の検証コード

`missing_publication_date`、`duplicate_video_reference`、`destination_section_missing`に加え、
invalid_classification、custody_not_committed、stored_original_row_missing、destination_row_missingを区別する。
型付きの固定コードだけをreportへ渡し、本文/認証情報/raw例外は含めない。
重複やセクション不在はメタデータ待ちとして無視せず失敗のままにする。

## 検証・導入・ロールバック

同じ鈴木沙透ページの2件/revision 3を再現したSQLite/偽APIテストで、繰り返し待ち・Wiki行維持・
判断/receipt/prepare/history保持・一部の復旧・全件復旧・二重反映なしを検証する。
Worker/キャッシュの日時再利用、部分メタデータ、null/不正日時の再import、API障害、Dry Runも検証する。
既存の429/フェーズ間延期、Wikiガード、スケジュール/動画更新、人間の編集保護のテストも維持する。

レビュー後のmainマージでActions側修正を利用できる。Worker再importの日時保護は同じDO bindingと既存設定を
保持して手動でWorkerを更新する。新しいSecrets/Variablesやschema移行は不要。本作業ではデプロイしない。
ロールバックはActionsの変更をrevertし、必要なら同じbindingの旧Worker bundleへ戻す。
分類DB・キャッシュ・履歴・prepare journalを削除/初期化しない。
