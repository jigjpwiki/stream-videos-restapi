/**
 * WIKIWIKI REST API クライアント
 *
 * 環境変数:
 *   WIKI_API_BASE_URL  - API ベース URL (例: https://api.wikiwiki.jp/jigjp)
 *   WIKI_PASSWORD      - WIKIWIKI パスワード（/auth で token を取得するために使用）
 *
 * エンドポイント仕様 (WIKIWIKI REST API v1):
 *   POST {base}/auth                      - 認証 → token 取得
 *   GET  {base}/page/{encoded_page_name}  - ページ本文取得
 *   PUT  {base}/page/{encoded_page_name}  - ページ本文更新
 */

const BASE_URL = process.env.WIKI_API_BASE_URL;

/**
 * /auth エンドポイントでパスワード認証を行い、Bearer token を取得する
 * @returns {Promise<string>} token
 * @throws 認証失敗時
 */
async function authenticate() {
  const password = process.env.WIKI_PASSWORD;
  console.log(`[INFO] WIKI_PASSWORD exists: ${Boolean(password)}`);

  const res = await fetch(`${BASE_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WIKIWIKI auth failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const token = data.token ?? null;
  console.log(`[INFO] WIKI token acquired: ${Boolean(token)}`);

  if (!token) {
    throw new Error('WIKIWIKI auth response did not contain a token');
  }

  return token;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * WIKIWIKI ページ本文を取得する
 * @param {string} pageName ページ名 (例: "ライバー名/動画一覧")
 * @returns {Promise<string>} ページ本文テキスト
 * @throws ページ取得失敗時
 */
export async function getPage(pageName) {
  const token = await authenticate();
  const url = `${BASE_URL}/page/${encodeURIComponent(pageName)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `WIKIWIKI GET page failed [${pageName}]: ${res.status} ${body}`
    );
  }

  const data = await res.json();
  return data.source ?? '';
}

/**
 * WIKIWIKI ページ本文を更新する
 * @param {string} pageName ページ名
 * @param {string} content  更新後のページ本文
 * @returns {Promise<void>}
 * @throws ページ更新失敗時
 */
export async function updatePage(pageName, content) {
  const token = await authenticate();
  const url = `${BASE_URL}/page/${encodeURIComponent(pageName)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ source: content }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `WIKIWIKI PUT page failed [${pageName}]: ${res.status} ${body}`
    );
  }
}
