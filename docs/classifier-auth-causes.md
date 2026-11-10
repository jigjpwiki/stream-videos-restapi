# Worker認証の原因分類と公開鍵キャッシュ

## 本番事象と分かっている範囲

利用者から約8回に1回の401と、保存後の件数取得に対する403が報告された。
例: requestId `a5f71002-10bb-4fa3-8442-9956053bad8c`。
別タブの再認証リンクではダッシュボードが開き、元画面の更新で復帰した。
その後、**利用者がCloudflare側を調整して本番は復旧済み**と報告している。
変更した設定項目は現時点で未確認であり、このPRによる本番復旧とは主張しない。

従来Workerは全認証例外をaccess_denied/403へ変換し、公開鍵取得失敗もJWT不一致も編集者不一致も
同じログにしていた。そのため、上記requestIdの過去ログから詳細原因を復元することはできない。
この環境には本番Cloudflare Logs/Analyticsの閲覧資格情報もなく、当該403の実原因は断定できない。
Access側の401、Workerの403、公開鍵サービスの障害、Cloudflare設定変更による改善を混同しない。

コードで確認・再現した問題は、(1)一時的な公開鍵障害も権限不足403になる、
(2)キャッシュ中の未知kidに対して公開鍵を再取得せず鍵更新後に拒否する、
(3)同時cold requestが公開鍵を重複取得する、(4)UIがすべての403で再認証を要求すること。
同一の有効JWT/編集権限を32個のcold verifierへ渡し、8回に1回だけJWKSを503にする制御再現では、
旧処理は8回ごとに403、新処理は理由付き503となる。これは**再現fixture**であり、本番原因の証明ではない。

## 応答と診断

Worker由来の認証失敗はJSONにcode/authSource=worker/authAction/requestIdを返し、
`X-Classifier-Auth-Source: worker` と `X-Request-Id`を付ける。
AccessでWorker到達前に返る401/403にはこのWorkerマーカーがなく、UIではaccess_or_edgeとして区別する。
中間応答の情報が欠ける場合はunknownのまま扱い、推測でWorker障害と断定しない。

|原因コード|HTTP|画面の対応|
|---|---|---|
|jwt_missing / jwt_expired|401|認証JWT欠落/期限切れ。再認証を案内|
|jwt_malformed / jwt_algorithm_invalid|403|JWT形式/方式不正。管理者確認|
|jwt_signature_invalid|403|署名検証失敗。管理者確認|
|jwt_issuer_mismatch / jwt_audience_mismatch|403|issuer/audience不一致。管理者確認|
|jwt_time_invalid / jwt_issued_in_future / jwt_not_yet_valid|403|時刻情報の不正/未来発行/nbf。時刻・設定確認|
|jwt_identity_missing|403|署名対象の編集者情報なし。管理者確認|
|jwt_unknown_key|403|有効な公開鍵応答にも対応鍵なし。鍵/設定確認|
|editor_not_allowed|403|編集者許可リストに不一致。権限確認。再ログインを強制しない|
|auth_configuration / editor_configuration|500|Worker認証/許可リストの設定不備。管理者確認|
|auth_keys_http|503|JWKSのHTTP失敗。upstreamStatusもログで確認|
|auth_keys_network / auth_keys_timeout|503|JWKS通信失敗/timeout。再認証ではなく再確認|
|auth_keys_redirect / auth_keys_invalid|503|JWKS転送/応答・鍵形式不正。取得元/設定確認|
|auth_check_unavailable|503|未分類の認証内部障害。安全側で拒否しログ確認|

診断イベントは固定route、stage=auth、status、原因code、requestId、必要な数値upstreamStatusだけ。
JWT、Cookie、メール、issuer/audience/kidの値、公開鍵本文、URL/query、raw例外はログに出さない。
Worker/DOの後続イベントとは同じrequestIdで照合できる。失敗した認証はDOへ到達しない。

## 公開鍵取得の堅牢化（認証は毎回検証）

- issuerごとに公開鍵だけを5分キャッシュし、CryptoKeyのimport結果を再利用する。
- 同時cold/期限切れ取得は同じPromiseへ集約する（isolate内）。isolateを跨ぐcache共有はしない。
- 未知kidがキャッシュに現れたら、最大30秒に1回だけ公開鍵を再取得して鍵更新を確認する。
  取得直後にも未知の場合は繰り返さず拒否する。未知kidをログや無制限なnegative cacheに保存しない。
- JSON/鍵集合の検証とRSA公開鍵importがすべて成功した場合のみ、集合を原子的に差し替える。
  RS256は2048bit以上を要求。部分応答や不正な鍵をcacheへ混ぜない。
- 5秒timeoutとredirect=manualを維持。JWKSの自動HTTP再試行は追加しない。
- 期限切れcacheは取得失敗時にも使用しない。まだTTL内の既知鍵は、別の未知kidの取得失敗で壊さない。
- JWTそのもの、署名確認結果、編集者の許可結果はcacheしない。
  各リクエストで署名、issuer/audience、有効期間、iat/nbf、最新の許可リストを検証する。
  公開鍵取得中に期限が切れたJWTも拒否する。

## UIの保存成功と認証障害

UIはヘッダー/JSONのWorkerマーカーと許可した固定原因コードから対応を決め、
任意のメッセージやauthActionをそのまま信用・ログ出力しない。
Access/Edgeの401や転送、Workerのjwt_missing/jwt_expiredだけを再認証対象にする。
原因不明の403は権限/アクセス制限として扱い、再認証を自動要求しない。401や転送とは区別し、CF-Ray等で確認する。

公開鍵503や管理者確認が必要なWorker403で、保存済みの分類を取り消したりログインを要求したりしない。
件数取得だけの失敗は保存成功のまま警告と原因code/requestIdを表示し、画面操作を維持する。
POSTがWorker認証で拒否された場合はDOに到達していないため、保存確認GETやPOST再試行を自動追加しない。
次の操作の可否はサーバーが毎回検証する。UIの継続は認証・CSRFの迂回にはならない。
不明な通信切断や500は引き続きrevision照合し、二重送信を防ぐ。

## 検証・導入

単体テストで原因コード、署名・audience・expiry・編集者拒否、JWKS 429/5xx/転送/timeout/不正応答、
cold並列取得、鍵更新、未知kidの抑制、期限切れcache不使用、issuer分離、許可リスト即時反映を検証する。
ブラウザでは8回ごとの件数503、Worker403/500、実認証不足401、POST認証拒否を挿入し、
保存成功・操作継続・必要時だけの再認証・履歴の非重複を確認する。既存の連続60件/CSP/CSRFも維持する。

本番は利用者の設定調整で復旧済みであり、急いで未検証のdeployを行う手順ではない。
レビュー後にnpm test、npm run test:browser、npm run classifier:smokeを実施し、
同じDO binding/Secrets/既存varsを保持してUI/APIを同じbundleで手動更新する。
Access policyやsession時間、CSRF保護は変更しない。DO schema/判断/history/receipt/custodyも変更しない。
ロールバックは同じbindingで旧bundleへ戻す。データを削除/初期化しない。
この作業では本番deploy・設定変更・本番データ変更を行っていない。
