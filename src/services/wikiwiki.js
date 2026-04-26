/**
 * WIKIWIKI REST API クライアント
 *
 * 環境変数:
 *   WIKI_API_BASE_URL  - API ベース URL (例: https://api.wikiwiki.jp/jigjp)
 *   WIKI_PASSWORD      - API トークン (Bearer 認証)
 *
 * エンドポイント仕様 (WIKIWIKI REST API v1):
 *   GET  {base}/page/{encoded_page_name}  - ページ本文取得
 *   PUT  {base}/page/{encoded_page_name}  - ページ本文更新
 */

const BASE_URL = process.env.WIKI_API_BASE_URL;
const TOKEN = process.env.WIKI_PASSWORD;

function getHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function encodedPath(pageName) {
  return encodeURIComponent(pageName);
}

/**
 * WIKIWIKI ページ本文を取得する
 * @param {string} pageName ページ名 (例: "ライバー名/動画一覧")
 * @returns {Promise<string>} ページ本文テキスト
 * @throws ページ取得失敗時
 */
export async function getPage(pageName) {
  const url = `${BASE_URL}/page/${encodedPath(pageName)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
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
  const url = `${BASE_URL}/page/${encodedPath(pageName)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ source: content }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `WIKIWIKI PUT page failed [${pageName}]: ${res.status} ${body}`
    );
  }
}
