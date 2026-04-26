/**
 * WIKIWIKI テキストフォーマッター
 *
 * 動画情報をWIKIWIKI記法に変換し、既存ページテキストへ挿入する。
 */

// セクション見出しの定義
const SECTION_HEADERS = {
  liveArchive: '**ライブ配信（アーカイブ） [#archives]',
  normal: '**投稿動画 [#edited_videos]',
  shorts: '***Shorts動画 [#shorts]',
};

/**
 * タイトルをWIKIWIKI リンク構文向けにサニタイズする
 * @param {string} title
 * @returns {string}
 */
function sanitizeTitle(title) {
  return title
    .replace(/\r?\n/g, ' ')      // 改行 → スペース
    .replace(/ {2,}/g, ' ')      // 連続スペース → 1個
    .replace(/\]\]/g, '】】')    // ]] → 全角
    .trim();
}

/**
 * 動画の基準日時文字列を返す
 * - liveArchive: actualStartTime 優先、なければ publishedAt
 * - その他: publishedAt
 * @param {{ videoType: string, actualStartTime: string|null, publishedAt: string }} video
 * @returns {string}
 */
function getBaseDateStr(video) {
  if (video.videoType === 'liveArchive' && video.actualStartTime) {
    return video.actualStartTime;
  }
  return video.publishedAt;
}

/**
 * 日付文字列を JST の Date に変換する
 * @param {string} dateStr
 * @returns {Date}
 */
function toJST(dateStr) {
  const d = new Date(dateStr);
  return new Date(d.getTime() + 9 * 60 * 60 * 1000);
}

/**
 * 動画1件のWIKI記法行を生成する
 *   -MM/DD &color(red){■};[[タイトル:URL]]
 * @param {{ title: string, url: string, videoType: string, publishedAt: string, actualStartTime: string|null }} video
 * @returns {string}
 */
export function formatVideoLine(video) {
  const baseDateStr = getBaseDateStr(video);
  const jstDate = toJST(baseDateStr);
  const mm = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jstDate.getUTCDate()).padStart(2, '0');

  const safeTitle = sanitizeTitle(video.title);
  return `-${mm}/${dd} &color(red){■};[[${safeTitle}:${video.url}]]`;
}

// ---------------------------------------------------------------------------
// 内部ユーティリティ
// ---------------------------------------------------------------------------

/**
 * 行配列内で指定テキストを含む行のインデックスを返す。見つからなければ -1。
 * @param {string[]} lines
 * @param {string} text
 * @returns {number}
 */
function findLineIndex(lines, text) {
  return lines.findIndex((l) => l.trim() === text.trim());
}

/**
 * 見出しレベルを返す (* の個数)
 * @param {string} line
 * @returns {number}
 */
function headingLevel(line) {
  const m = line.match(/^(\*+)/);
  return m ? m[1].length : 0;
}

/**
 * セクション見出し行から、次の同レベル以上の見出し行の直前インデックスを返す。
 * (セクションの終端インデックス = 排他)
 * @param {string[]} lines
 * @param {number} startIdx セクション見出し行のインデックス
 * @returns {number}
 */
function findSectionEnd(lines, startIdx) {
  const level = headingLevel(lines[startIdx]);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const lv = headingLevel(lines[i]);
    if (lv > 0 && lv <= level) {
      return i;
    }
  }
  return lines.length;
}

/**
 * #fold(LABEL) または #fold(LABEL,state) のラベルを返す。マッチしなければ null。
 * @param {string} line
 * @returns {string|null}
 */
function parseFoldLabel(line) {
  const m = line.match(/^#fold\(([^,)]+)/);
  return m ? m[1].trim() : null;
}

/**
 * コメントアウトされた fold ブロックを有効化して open に変更する。
 * //# fold(...) → #fold(...,open)
 * @param {string[]} lines
 * @param {number} foldStart   "//#fold(..." 行のインデックス
 * @param {number} sectionEnd  セクション終端インデックス（排他）
 * @returns {number} 有効化後の #fold 行インデックス (同じ位置)
 */
function uncommentFoldBlock(lines, foldStart, sectionEnd) {
  // foldStart から }}  or  //}} までの範囲をアンコメント
  const label = parseFoldLabel(lines[foldStart].replace(/^\/\//, ''));
  lines[foldStart] = `#fold(${label},open){{`;

  for (let i = foldStart + 1; i < sectionEnd; i++) {
    if (/^\/\//.test(lines[i])) {
      lines[i] = lines[i].replace(/^\/\//, '');
      if (lines[i].trim() === '}}') {
        break;
      }
    } else {
      break;
    }
  }
  return foldStart;
}

/**
 * #fold(...) ブロックの "open" 状態を取り除く（close にする）
 * @param {string} foldLine
 * @returns {string}
 */
function closeFold(foldLine) {
  return foldLine.replace(/#fold\(([^,)]+),open\)/, '#fold($1)');
}

/**
 * #fold(...) ブロックに "open" を追加する
 * @param {string} foldLine
 * @returns {string}
 */
function openFold(foldLine) {
  // すでに ,open がある場合はそのまま
  if (foldLine.includes(',open)')) return foldLine;
  return foldLine.replace(/#fold\(([^)]+)\)/, '#fold($1,open)');
}

/**
 * 指定範囲内で '#fold(LABEL ...){{' 行を探す。
 * コメントアウト '//#fold(LABEL' も対象とし、見つかればアンコメントして返す。
 * @returns {{ idx: number, wasComment: boolean } | null}
 */
function findFold(lines, label, rangeStart, rangeEnd) {
  for (let i = rangeStart; i < rangeEnd; i++) {
    const stripped = lines[i].replace(/^\/\//, '');
    if (parseFoldLabel(stripped) === label) {
      const wasComment = lines[i].startsWith('//');
      return { idx: i, wasComment };
    }
  }
  return null;
}

/**
 * fold ブロックの閉じ括弧 '}}' のインデックスを返す。
 * ネストを考慮する。
 * @param {string[]} lines
 * @param {number} openIdx  '#fold..{{' 行のインデックス
 * @returns {number} '}}' 行のインデックス
 */
function findFoldClose(lines, openIdx) {
  let depth = 1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.endsWith('{{') || t.endsWith('{{{')) depth++;
    if (t === '}}' || t === '}}}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return lines.length - 1;
}

// ---------------------------------------------------------------------------
// ライブ配信アーカイブ挿入
// ---------------------------------------------------------------------------

/**
 * ライブ配信アーカイブセクションに動画行を挿入する。
 *
 * 構造:
 *   **ライブ配信（アーカイブ） [#archives]
 *   ***YYYY年 [#archivesYYYY]
 *   #fold(M月){{
 *   ''M月''
 *   -MM/DD ...
 *   }}
 *
 * @param {string[]} lines  ページ全行（破壊的に変更）
 * @param {number} secStart セクション先頭インデックス
 * @param {number} secEnd   セクション終端インデックス（排他）
 * @param {string} videoLine 挿入する行
 * @param {number} year     年 (JST)
 * @param {number} month    月 (JST, 1-12)
 */
function insertIntoArchiveSection(lines, secStart, secEnd, videoLine, year, month) {
  const yearHeader = `***${year}年 [#archives${year}]`;
  const monthLabel = `${month}月`;

  // --- 年見出しを探す / なければ作成 ---
  let yearIdx = -1;
  for (let i = secStart + 1; i < secEnd; i++) {
    if (lines[i].trim() === yearHeader) {
      yearIdx = i;
      break;
    }
  }

  if (yearIdx === -1) {
    // 年見出しを末尾に追加
    lines.splice(secEnd, 0, yearHeader, '');
    yearIdx = secEnd;
    secEnd += 2;
  }

  const yearSectionEnd = findSectionEnd(lines, yearIdx);
  const effectiveSecEnd = Math.min(secEnd, yearSectionEnd);

  // --- 月 fold を探す ---
  const foldResult = findFold(lines, monthLabel, yearIdx + 1, effectiveSecEnd);

  if (foldResult) {
    let foldIdx = foldResult.idx;
    if (foldResult.wasComment) {
      uncommentFoldBlock(lines, foldIdx, effectiveSecEnd);
      lines[foldIdx] = openFold(lines[foldIdx]);
    }
    const closeIdx = findFoldClose(lines, foldIdx);
    // closeIdx の直前に挿入
    lines.splice(closeIdx, 0, videoLine);
  } else {
    // 月 fold を新規作成
    const newFold = [
      `#fold(${monthLabel},open){{`,
      `''${monthLabel}''`,
      videoLine,
      '}}',
      '',
    ];
    lines.splice(effectiveSecEnd, 0, ...newFold);
  }
}

// ---------------------------------------------------------------------------
// 通常投稿動画挿入
// ---------------------------------------------------------------------------

/**
 * 投稿動画セクションに動画行を挿入する。
 *
 * 構造:
 *   **投稿動画 [#edited_videos]
 *   #fold(YYYY年,open){{
 *   ''YYYY年''
 *   -MM/DD ...
 *   }}
 *
 * @param {string[]} lines
 * @param {number} secStart
 * @param {number} secEnd
 * @param {string} videoLine
 * @param {number} year
 */
function insertIntoNormalSection(lines, secStart, secEnd, videoLine, year) {
  const yearLabel = `${year}年`;

  const foldResult = findFold(lines, yearLabel, secStart + 1, secEnd);

  if (foldResult) {
    let foldIdx = foldResult.idx;
    if (foldResult.wasComment) {
      uncommentFoldBlock(lines, foldIdx, secEnd);
    }
    // 現在年は open に
    lines[foldIdx] = openFold(lines[foldIdx]);

    // 前年の fold を close に
    for (let i = secStart + 1; i < foldIdx; i++) {
      if (lines[i].startsWith('#fold(') && lines[i].includes(',open)')) {
        lines[i] = closeFold(lines[i]);
      }
    }

    const closeIdx = findFoldClose(lines, foldIdx);
    lines.splice(closeIdx, 0, videoLine);
  } else {
    // 既存年 fold を close
    for (let i = secStart + 1; i < secEnd; i++) {
      if (lines[i].startsWith('#fold(') && lines[i].includes(',open)')) {
        lines[i] = closeFold(lines[i]);
      }
    }

    // 新しい年 fold を末尾に追加
    const newFold = [
      `#fold(${yearLabel},open){{`,
      `''${yearLabel}''`,
      videoLine,
      '}}',
      '',
    ];
    lines.splice(secEnd, 0, ...newFold);
  }
}

// ---------------------------------------------------------------------------
// Shorts 挿入
// ---------------------------------------------------------------------------

/**
 * Shorts セクションに動画行を挿入する。
 *
 * 構造:
 *   ***Shorts動画 [#shorts]
 *   #fold(YYYY年,open){{{
 *   ''YYYY年''
 *   #fold(M月,open){{
 *   ''M月''
 *   -MM/DD ...
 *   }}
 *   }}}
 */
function insertIntoShortsSection(lines, secStart, secEnd, videoLine, year, month) {
  const yearLabel = `${year}年`;
  const monthLabel = `${month}月`;

  // --- 年 outer fold を探す / なければ作成 ---
  const yearFoldResult = findFold(lines, yearLabel, secStart + 1, secEnd);
  let yearFoldIdx;

  if (yearFoldResult) {
    yearFoldIdx = yearFoldResult.idx;
    if (yearFoldResult.wasComment) {
      uncommentFoldBlock(lines, yearFoldIdx, secEnd);
    }
    lines[yearFoldIdx] = openFold(lines[yearFoldIdx]);

    // 前年 fold を close
    for (let i = secStart + 1; i < yearFoldIdx; i++) {
      if (lines[i].startsWith('#fold(') && lines[i].includes(',open)')) {
        const lv = parseFoldLabel(lines[i]);
        if (lv && lv.endsWith('年')) {
          lines[i] = closeFold(lines[i]);
        }
      }
    }
  } else {
    // 既存年 fold を close
    for (let i = secStart + 1; i < secEnd; i++) {
      if (lines[i].startsWith('#fold(') && lines[i].includes(',open)')) {
        const lv = parseFoldLabel(lines[i]);
        if (lv && lv.endsWith('年')) {
          lines[i] = closeFold(lines[i]);
        }
      }
    }

    // 新年 fold を末尾に挿入 (中身は後で追加するので空で)
    const newYearFold = [
      `#fold(${yearLabel},open){{{`,
      `''${yearLabel}''`,
      '}}}',
      '',
    ];
    lines.splice(secEnd, 0, ...newYearFold);
    yearFoldIdx = secEnd;
    secEnd += newYearFold.length;
  }

  // year fold の閉じ括弧 }}} を探す
  const yearCloseIdx = findFoldClose(lines, yearFoldIdx);

  // --- 月 inner fold を探す ---
  const monthFoldResult = findFold(
    lines,
    monthLabel,
    yearFoldIdx + 1,
    yearCloseIdx
  );

  if (monthFoldResult) {
    let monthFoldIdx = monthFoldResult.idx;
    if (monthFoldResult.wasComment) {
      uncommentFoldBlock(lines, monthFoldIdx, yearCloseIdx);
    }
    lines[monthFoldIdx] = openFold(lines[monthFoldIdx]);

    // 当月以外を close
    for (let i = yearFoldIdx + 1; i < yearCloseIdx; i++) {
      if (
        lines[i].startsWith('#fold(') &&
        lines[i].includes(',open)') &&
        i !== monthFoldIdx
      ) {
        lines[i] = closeFold(lines[i]);
      }
    }

    const monthCloseIdx = findFoldClose(lines, monthFoldIdx);
    lines.splice(monthCloseIdx, 0, videoLine);
  } else {
    // 当月以外 close
    for (let i = yearFoldIdx + 1; i < yearCloseIdx; i++) {
      if (lines[i].startsWith('#fold(') && lines[i].includes(',open)')) {
        lines[i] = closeFold(lines[i]);
      }
    }

    // 月 fold を year fold の閉じ括弧の直前に追加
    const newMonthFold = [
      `#fold(${monthLabel},open){{`,
      `''${monthLabel}''`,
      videoLine,
      '}}',
    ];
    lines.splice(yearCloseIdx, 0, ...newMonthFold);
  }
}

// ---------------------------------------------------------------------------
// 重複チェック
// ---------------------------------------------------------------------------

/**
 * ページ本文内に videoId が既に存在するか確認する
 * @param {string} pageText
 * @param {string} videoId
 * @returns {boolean}
 */
export function isVideoAlreadyInPage(pageText, videoId) {
  return pageText.includes(videoId);
}

// ---------------------------------------------------------------------------
// メイン挿入関数
// ---------------------------------------------------------------------------

/**
 * ページ本文に動画行を挿入した新しいテキストを返す。
 * セクションが見つからない場合は null を返す（更新しない）。
 *
 * @param {string} pageText  現在のページ本文
 * @param {{ videoType: string, publishedAt: string, title: string, url: string }} video
 * @returns {string|null}
 */
export function insertVideoIntoPage(pageText, video) {
  const headerText = SECTION_HEADERS[video.videoType];
  if (!headerText) {
    return null;
  }

  const lines = pageText.split('\n');

  const secStart = findLineIndex(lines, headerText);
  if (secStart === -1) {
    return null; // セクション未検出 → 更新しない
  }

  const secEnd = findSectionEnd(lines, secStart);
  const videoLine = formatVideoLine(video);

  // JST 日付（liveArchive は actualStartTime 優先）
  const baseDateStr = getBaseDateStr(video);
  const jstDate = toJST(baseDateStr);
  const year = jstDate.getUTCFullYear();
  const month = jstDate.getUTCMonth() + 1;

  const jstDateStr = `${year}-${String(month).padStart(2, '0')}-${String(jstDate.getUTCDate()).padStart(2, '0')}`;
  const mm = String(month).padStart(2, '0');
  const dd = String(jstDate.getUTCDate()).padStart(2, '0');
  console.log(
    `[DEBUG] videoId=${video.videoId} usedDateUTC=${baseDateStr} usedDateJST=${jstDateStr} MM/DD=${mm}/${dd}`
  );

  switch (video.videoType) {
    case 'liveArchive':
      insertIntoArchiveSection(lines, secStart, secEnd, videoLine, year, month);
      break;
    case 'normal':
      insertIntoNormalSection(lines, secStart, secEnd, videoLine, year);
      break;
    case 'shorts':
      insertIntoShortsSection(lines, secStart, secEnd, videoLine, year, month);
      break;
    default:
      return null;
  }

  return lines.join('\n');
}
