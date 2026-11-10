# 分類APIのAccess転送・通信障害からの復帰

## 確認できた原因と、未確認の項目

利用者の2026-11-10 17:41頃（JST）のNetwork情報で、POST /api/decisionがHTTP 302、
Content-Type: text/html、Cloudflare Accessのlogin URLへのLocationを返していた。
この302はWorker/DOの分類失敗ではなく、Accessで認証の再確認が必要になった応答。
旧api()はfetchの既定redirect=followでログイン画面を追い、クロスOrigin転送のCORS拒否、
HTML/JSON解析失敗、実ネットワーク障害を同じ「通信を確認できませんでした」に変換していた。
画面内の更新も同じAPI fetchなのでログイン画面へ遷移できず、同じ状態を繰り返す。

本番データを変更しないGET /api/state?counts=1で比較し、次を確認した。

|認証なしリクエストのX-Requested-With|応答|Content-Type|転送|
|---|---|---|---|
|wiki-classifier|302|text/html|Access loginへ|
|XMLHttpRequest|401|text/html|なし|

本番への分類POSTや認証済みセッションでの連続操作は実行していない。
共有ブラウザの接続は失敗したため、読み取りHTTP確認とローカルブラウザ再現を用いた。
Accessの具体的なsession duration、cookie失効/更新の理由、認証が数本ごとに必要になる設定要因は未確認。
Cloudflareアカウントの本番analytics/log権限はこの環境にないため、CPU/request/SQL/無料枠の実使用量は未確認。
確認された302については、DOの5xxやquota超過を原因とする証拠はない。
別の障害が併存しないことまで断定せず、401/403、429/5xx、timeout、fetch失敗を今後の診断で分離する。

## 修正する動作

- 全API（GETも含む）にX-Requested-With: XMLHttpRequest、Accept: application/jsonを送る。
  Accessが未認証AJAXに返す401を明示的に扱い、認証を迂回したりsession期間を延長したりしない。
- POSTはさらにX-Classifier-Request: wiki-classifierを必須にし、同一Origin・JSONの検証も維持する。
  XMLHttpRequestヘッダーだけで編集を許可しない。旧クライアントの専用ヘッダーも互換性のため受け付ける。
- redirect=manual、mode=same-origin、credentials=same-origin、cache=no-storeを使用。
  万一の転送は追わず判別する。ブラウザのopaqueredirectはstatus=0で、Location/実302は読めないため推測で記録しない。
- status、Content-Typeの安全な分類（json/html/text/other/missing）、転送有無、応答形式を別々に検証する。
  HTML本文、Location、応答URL/query、例外生文、Cookie/JWT/Token/個人情報はログに出さない。
- 401/403/転送/HTML応答では、同一Originのルートを別タブで開く「認証をやり直す」を表示。
  認証完了後は元の画面の「更新」で再取得し、操作を再開する。取得成功までは分類を止める。
  HTMLが必ずログイン画面だとは断定せず、HTTP status/形式も表示する。
- 保存済みの分類と、後続一覧/件数取得の失敗を区別する。成功した保存を失敗として再送しない。
- 保存結果が不明なときはpendingとして保持。POSTを自動で繰り返さず、対象の最新revisionをGETで照合する。
  確認GETも失敗した場合は書込みをロックし、「更新」で照合を再開する。
  保存済み/未保存/別編集との競合を確認してから、ユーザーが次の操作を行う。
- 新しい操作が始まったら旧件数取得を中止し、古い応答で新しい認証状態や表示を上書きさせない。
- 通信の15秒期限と全操作のfinallyによるロック解除を維持。JSONが読めてもカード/一覧/履歴の形が不正なら、
  表示処理へ渡す前に止める。cursorが進まない応答でも無限取得しない。

## 診断と本番での確認

Workerの入口でrequestIdを生成し、DOへ同じIDを渡してX-Request-Idレスポンスヘッダーへ返す。
Worker/DOの固定route、status、code、stage、elapsedMsを同じIDで関連付ける。
elapsedMsは経過時間であり、Cloudflare CPU時間やquota実績そのものではない。
AccessがWorker到達前に401/302等を返す場合にはWorker requestIdは付かない。
読める場合はCF-Rayを相関用に表示・記録する。opaque redirectではどちらも取得できないことがある。

調査時は、発生時刻（JST）、固定APIパス、status、形式分類、requestId/CF-Rayだけを共有する。
Cookie、JWT、Authorization、Locationのquery、Network全文/HAR、動画行の本文は共有しない。
401/302ならAccessのsession/loginの確認、429/5xxなら該当IDのWorker logs/Analytics/無料枠を確認する。
CORS・DNS・TLS・offlineはブラウザが同じTypeErrorにすることがあるため、fetch_failedだけで原因を断定しない。

## 検証と導入

ローカルの実モデル/SQLite DO APIへ接続するPlaywrightで、連続分類の途中に302、401/403、HTML、
不正JSON/形式、429/503、通信切断、保存後の一覧/件数失敗を挿入する。
保存commit後の応答喪失→確認GET失敗→更新で復帰、500後のrevision照合、古い非同期応答、
timeout後のロック解除も検証する。旧UIでは302のケースで一般的通信エラーになることを再現した。
CSRFの新旧ヘッダー、異なるOrigin、専用ヘッダー欠落、requestId一貫性は自動テストする。

npm test、npm run test:browser、npm run classifier:smokeで確認する。
この修正はDOのschema、分類判断、動画データ、history、custody/receiptを変更しない。
本番Worker/Wiki/data、Variables/Secrets、Access policy/session設定は変更しない。

レビュー・承認後の手動導入時は、同じDO binding・Secrets・既存feature flag/varsの値を保ってUI/APIを同じWorker bundleで更新する。
POSTヘッダーが新旧互換なので旧タブの要求を破壊しないが、新しい復帰機能を読み込むには最初に1回ページを再読み込みする。
その後の認証再確認は別タブのログインと画面内「更新」で行える。
ロールバックは同じbindingの旧bundleへ戻し、DOを削除/初期化しない（元の302処理問題は再発し得る）。
