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
 * 現在日時を JST の Date で返す
 * @returns {Date}
 */
function nowJST() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
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
// ソート挿入ユーティリティ
// ---------------------------------------------------------------------------

/**
 * fold ブロック内の動画行（-MM/DD ...）を日付・時刻昇順に並べ替えて新規行を挿入する。
 *
 * ソートキーの統一: toJST(str).getTime() = originalUTC_ms + 9h と同じ空間で比較する。
 *   - 既存行（時刻情報なし）: Date.UTC(year, mm-1, dd) = JST 00:00 相当のソートキー
 *   - 新規行: jstDate.getTime() (= toJST(baseDateStr).getTime())
 *
 * @param {string[]} lines       ページ行配列（破壊的に変更）
 * @param {number} foldOpenIdx   '#fold..{{' 行のインデックス
 * @param {number} foldCloseIdx  '}}' or '}}}' 行のインデックス
 * @param {number} year          fold が属する年（JST）
 * @param {string} newVideoLine  追加する動画行
 * @param {number} newSortKey    新規行のソートキー（ms）
 */
function insertSorted(lines, foldOpenIdx, foldCloseIdx, year, newVideoLine, newSortKey) {
  // fold ブロック内の動画行インデックスを収集
  const videoIdxs = [];
  for (let i = foldOpenIdx + 1; i < foldCloseIdx; i++) {
    if (/^-\d{2}\/\d{2}[ \t]/.test(lines[i])) {
      videoIdxs.push(i);
    }
  }

  // 既存行のソートエントリ（時刻なし → MM/DD 00:00 JST として扱う）
  const entries = videoIdxs.map((idx) => {
    const m = lines[idx].match(/^-(\d{2})\/(\d{2})[ \t]/);
    const mm = m ? parseInt(m[1], 10) : 1;
    const dd = m ? parseInt(m[2], 10) : 1;
    // Date.UTC(year, mm-1, dd) = JST 00:00 を shifted UTC 空間で表した値
    const sortKey = Date.UTC(year, mm - 1, dd);
    return { line: lines[idx], sortKey };
  });

  // 新規行を追加してソート（昇順）
  entries.push({ line: newVideoLine, sortKey: newSortKey });
  entries.sort((a, b) => a.sortKey - b.sortKey);

  // 既存動画行を逆順で削除（インデックスズレ防止）
  for (let i = videoIdxs.length - 1; i >= 0; i--) {
    lines.splice(videoIdxs[i], 1);
  }

  // foldCloseIdx をずらしてソート済み行を挿入
  const adjustedClose = foldCloseIdx - videoIdxs.length;
  lines.splice(adjustedClose, 0, ...entries.map((e) => e.line));
}

// ---------------------------------------------------------------------------
// ライブ配信アーカイブ挿入
// ---------------------------------------------------------------------------

/**
 * ライブ配信（アーカイブ）セクション内のすべての月 fold の open/close を調整する。
 * 当月（nowYear/nowMonth と一致する月）のみ open にし、それ以外は close にする。
 *
 * @param {string[]} lines
 * @param {number} secStart  セクション先頭インデックス
 * @param {number} secEnd    セクション終端インデックス（排他）
 * @param {number} nowYear   現在の年（JST）
 * @param {number} nowMonth  現在の月（JST, 1-12）
 */
function adjustArchiveMonthFolds(lines, secStart, secEnd, nowYear, nowMonth) {
  let currentYear = null;
  for (let i = secStart + 1; i < secEnd; i++) {
    const yearMatch = lines[i].match(/^\*{3}(\d{4})年/);
    if (yearMatch) {
      currentYear = parseInt(yearMatch[1], 10);
      continue;
    }
    const monthMatch = lines[i].match(/^#fold\((\d+)月/);
    if (monthMatch && currentYear !== null) {
      const foldMonth = parseInt(monthMatch[1], 10);
      const isCurrentMonth = (currentYear === nowYear && foldMonth === nowMonth);
      console.log(
        `[DEBUG] Month fold: ${currentYear}/${String(foldMonth).padStart(2, '0')} open=${isCurrentMonth}`
      );
      if (isCurrentMonth) {
        lines[i] = openFold(lines[i]);
      } else {
        lines[i] = closeFold(lines[i]);
      }
    }
  }
}

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
 * @param {number} newSortKey ソートキー（ms）
 */
function insertIntoArchiveSection(lines, secStart, secEnd, videoLine, year, month, newSortKey) {
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
    // fold 内の動画行をソートして挿入
    insertSorted(lines, foldIdx, closeIdx, year, videoLine, newSortKey);
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

  // 月 fold の open/close を一括調整: 当月のみ open、それ以外は close
  const nowJSTDate = nowJST();
  const nowYear = nowJSTDate.getUTCFullYear();
  const nowMonth = nowJSTDate.getUTCMonth() + 1;
  const freshSecEnd = findSectionEnd(lines, secStart);
  adjustArchiveMonthFolds(lines, secStart, freshSecEnd, nowYear, nowMonth);
}

// ---------------------------------------------------------------------------
// 通常投稿動画挿入
// ---------------------------------------------------------------------------

/**
 * 投稿動画セクション内のすべての年 fold の open/close を調整する。
 * 現在年（nowYear）のみ open にし、それ以外は close にする。
 *
 * @param {string[]} lines
 * @param {number} secStart  セクション先頭インデックス
 * @param {number} secEnd    セクション終端インデックス（排他）
 * @param {number} nowYear   現在の年（JST）
 */
function adjustNormalYearFolds(lines, secStart, secEnd, nowYear) {
  for (let i = secStart + 1; i < secEnd; i++) {
    const yearMatch = lines[i].match(/^#fold\((\d{4})年/);
    if (yearMatch) {
      const foldYear = parseInt(yearMatch[1], 10);
      const isCurrentYear = (foldYear === nowYear);
      console.log(
        `[DEBUG] Edited videos year fold: ${foldYear} open=${isCurrentYear}`
      );
      if (isCurrentYear) {
        lines[i] = openFold(lines[i]);
      } else {
        lines[i] = closeFold(lines[i]);
      }
    }
  }
}

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
 * @param {number} newSortKey ソートキー（ms）
 */
function insertIntoNormalSection(lines, secStart, secEnd, videoLine, year, newSortKey) {
  const yearLabel = `${year}年`;
  const nowJSTDate = nowJST();
  const nowYear = nowJSTDate.getUTCFullYear();

  const foldResult = findFold(lines, yearLabel, secStart + 1, secEnd);

  if (foldResult) {
    let foldIdx = foldResult.idx;
    if (foldResult.wasComment) {
      uncommentFoldBlock(lines, foldIdx, secEnd);
    }
    const closeIdx = findFoldClose(lines, foldIdx);
    insertSorted(lines, foldIdx, closeIdx, year, videoLine, newSortKey);
  } else {
    // 新しい年 fold を末尾に追加（現在年のみ open）
    const openAttr = year === nowYear ? ',open' : '';
    const newFold = [
      `#fold(${yearLabel}${openAttr}){{`,
      `''${yearLabel}''`,
      videoLine,
      '}}',
      '',
    ];
    lines.splice(secEnd, 0, ...newFold);
  }

  // 年 fold の open/close を一括調整: 現在年のみ open、それ以外は close
  const freshSecEnd = findSectionEnd(lines, secStart);
  adjustNormalYearFolds(lines, secStart, freshSecEnd, nowYear);
}

// ---------------------------------------------------------------------------
// Shorts 月fold open/close 調整
// ---------------------------------------------------------------------------

/**
 * Shorts 年fold直下の全月foldのopen/closeを調整する。
 * 当月のみ open、それ以外は close。
 * @param {string[]} lines
 * @param {number} yearFoldIdx  年fold行のインデックス
 * @param {number} year         年fold の年
 * @param {number} nowYear      現在年（JST）
 * @param {number} nowMonth     現在月（JST, 1-12）
 */
function adjustShortsMonthFolds(lines, yearFoldIdx, year, nowYear, nowMonth) {
  const yearCloseIdx = findFoldClose(lines, yearFoldIdx);
  let depth = 0;

  for (let i = yearFoldIdx + 1; i < yearCloseIdx; i++) {
    const t = lines[i].trim();

    // 月fold の open/close を depth=0（年fold直下）でのみ調整
    if (depth === 0 && lines[i].startsWith('#fold(')) {
      const label = parseFoldLabel(lines[i]);
      if (label && /^\d+月$/.test(label)) {
        const mm = parseInt(label, 10);
        const isCurrentMonth = year === nowYear && mm === nowMonth;
        console.log(
          `[DEBUG] Shorts month fold: ${year}/${String(mm).padStart(2, '0')} open=${isCurrentMonth}`
        );
        if (isCurrentMonth) {
          lines[i] = openFold(lines[i]);
        } else {
          lines[i] = closeFold(lines[i]);
        }
      }
    }

    // depth 更新（チェックの後）
    if (t.endsWith('{{') || t.endsWith('{{{')) depth++;
    if (t === '}}' || t === '}}}') {
      if (depth > 0) depth--;
    }
  }
}

// ---------------------------------------------------------------------------
// Shorts 年fold open/close 調整
// ---------------------------------------------------------------------------

/**
 * Shorts セクション内の全年foldのopen/closeを調整する。
 * 現在年のみ open、それ以外は close。
 * @param {string[]} lines
 * @param {number} secStart
 * @param {number} secEnd
 * @param {number} nowYear
 */
function adjustShortsYearFolds(lines, secStart, secEnd, nowYear) {
  for (let i = secStart + 1; i < secEnd; i++) {
    if (!lines[i].startsWith('#fold(')) continue;
    const label = parseFoldLabel(lines[i]);
    if (!label || !/^\d{4}年$/.test(label)) continue;
    const foldYear = parseInt(label, 10);
    const isCurrentYear = foldYear === nowYear;
    if (isCurrentYear) {
      lines[i] = openFold(lines[i]);
    } else {
      lines[i] = closeFold(lines[i]);
    }
  }
}

// ---------------------------------------------------------------------------
// Shorts 年fold直下の誤配置動画行を修正
// ---------------------------------------------------------------------------

/**
 * 年fold直下に誤って置かれた動画行（-MM/DD ...）を検出し、
 * 対応する月fold内に移動する。
 * @param {string[]} lines
 * @param {number} yearFoldIdx  年fold行のインデックス
 * @param {number} year         年fold の年
 * @returns {number} 修正した行数
 */
function fixShortsYearLevelLines(lines, yearFoldIdx, year) {
  const yearCloseIdx = findFoldClose(lines, yearFoldIdx);
  let depth = 0;
  const misplaced = []; // { idx, mm, dd, line }

  for (let i = yearFoldIdx + 1; i < yearCloseIdx; i++) {
    const t = lines[i].trim();

    if (t.endsWith('{{') || t.endsWith('{{{')) {
      depth++;
      continue;
    }
    if (t === '}}' || t === '}}}') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) {
      const m = lines[i].match(/^-(\d{2})\/(\d{2})[ \t]/);
      if (m) {
        misplaced.push({
          idx: i,
          mm: parseInt(m[1], 10),
          dd: parseInt(m[2], 10),
          line: lines[i],
        });
      }
    }
  }

  if (misplaced.length === 0) return 0;

  // 逆順に削除（インデックスずれ防止）
  for (let i = misplaced.length - 1; i >= 0; i--) {
    lines.splice(misplaced[i].idx, 1);
  }

  // 月別にグループ化して月fold内へ挿入
  const byMonth = new Map();
  for (const item of misplaced) {
    if (!byMonth.has(item.mm)) byMonth.set(item.mm, []);
    byMonth.get(item.mm).push(item);
  }

  for (const [mm, entries] of byMonth) {
    const monthLabel = `${mm}月`;
    const freshYearClose = findFoldClose(lines, yearFoldIdx);
    const freshFold = findFold(lines, monthLabel, yearFoldIdx + 1, freshYearClose);

    if (freshFold) {
      // 既存月foldへ追記してソート
      const mFoldIdx = freshFold.idx;
      let mClose = findFoldClose(lines, mFoldIdx);

      // 既存の動画行を収集・削除
      const existingIdxs = [];
      for (let k = mFoldIdx + 1; k < mClose; k++) {
        if (/^-\d{2}\/\d{2}[ \t]/.test(lines[k])) existingIdxs.push(k);
      }
      const existingLines = existingIdxs.map((k) => lines[k]);
      for (let k = existingIdxs.length - 1; k >= 0; k--) {
        lines.splice(existingIdxs[k], 1);
      }
      mClose -= existingIdxs.length;

      // 全動画行をソートして挿入
      const allVideos = [...existingLines, ...entries.map((e) => e.line)];
      allVideos.sort((a, b) => {
        const ma = a.match(/^-(\d{2})\/(\d{2})/);
        const mb = b.match(/^-(\d{2})\/(\d{2})/);
        if (!ma || !mb) return 0;
        return (
          Date.UTC(year, parseInt(ma[1], 10) - 1, parseInt(ma[2], 10)) -
          Date.UTC(year, parseInt(mb[1], 10) - 1, parseInt(mb[2], 10))
        );
      });
      lines.splice(mClose, 0, ...allVideos);
    } else {
      // 月foldが存在しないので新規作成
      const freshClose = findFoldClose(lines, yearFoldIdx);
      const videoLines = [...entries]
        .sort((a, b) => Date.UTC(year, a.mm - 1, a.dd) - Date.UTC(year, b.mm - 1, b.dd))
        .map((e) => e.line);
      const newFold = [
        `#fold(${monthLabel}){{`,
        `''${monthLabel}''`,
        ...videoLines,
        '}}',
      ];
      lines.splice(freshClose, 0, ...newFold);
    }
  }

  return misplaced.length;
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
 *
 * 動画行は必ず月fold内（月foldの閉じ `}}` 直前）に挿入される。
 * 年fold直下に誤配置された行があれば対応する月foldへ移動する。
 */
function insertIntoShortsSection(lines, secStart, secEnd, videoLine, year, month, newSortKey) {
  const yearLabel = `${year}年`;
  const monthLabel = `${month}月`;
  const nowJSTDate = nowJST();
  const nowYear = nowJSTDate.getUTCFullYear();
  const nowMonth = nowJSTDate.getUTCMonth() + 1;

  // --- Step 1: 年 outer fold を探す / なければ作成 ---
  const yearFoldResult = findFold(lines, yearLabel, secStart + 1, secEnd);
  let yearFoldIdx;

  if (yearFoldResult) {
    yearFoldIdx = yearFoldResult.idx;
    if (yearFoldResult.wasComment) {
      uncommentFoldBlock(lines, yearFoldIdx, secEnd);
      // uncommentFoldBlock は行数を変えないため secEnd は有効のまま
    }
  } else {
    // 新年 fold を secEnd 直前に挿入（中身は後で追加するので空で）
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

  // --- Step 2: 月 inner fold を探す / 動画行を挿入 ---
  const monthFoldResult = findFold(lines, monthLabel, yearFoldIdx + 1, yearCloseIdx);

  if (monthFoldResult) {
    const monthFoldIdx = monthFoldResult.idx;
    if (monthFoldResult.wasComment) {
      uncommentFoldBlock(lines, monthFoldIdx, yearCloseIdx);
      // uncommentFoldBlock は行数を変えないため yearCloseIdx は有効のまま
    }
    // 月fold閉じ `}}` の直前にソート挿入（月foldの外には一切置かない）
    const monthCloseIdx = findFoldClose(lines, monthFoldIdx);
    insertSorted(lines, monthFoldIdx, monthCloseIdx, year, videoLine, newSortKey);
  } else {
    // 月 fold を year fold の閉じ括弧の直前に新規作成（videoLine を内包）
    const newMonthFold = [
      `#fold(${monthLabel}){{`,
      `''${monthLabel}''`,
      videoLine,
      '}}',
    ];
    lines.splice(yearCloseIdx, 0, ...newMonthFold);
  }

  // --- Step 3: 年fold直下の誤配置動画行を修正 ---
  const fixedCount = fixShortsYearLevelLines(lines, yearFoldIdx, year);
  if (fixedCount > 0) {
    console.log(`[DEBUG] Shorts misplaced lines fixed: ${fixedCount}`);
  }

  // --- Step 4: 月fold の open/close を一括調整（当月のみ open）---
  adjustShortsMonthFolds(lines, yearFoldIdx, year, nowYear, nowMonth);

  // --- Step 5: 年fold の open/close を一括調整（現在年のみ open）---
  const freshSecEnd = findSectionEnd(lines, secStart);
  adjustShortsYearFolds(lines, secStart, freshSecEnd, nowYear);
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

  // ソートキー: toJST(baseDateStr).getTime() = originalUTC_ms + 9h
  // 既存行の MMDDソートキーと同じ空間（Date.UTC(year, mm-1, dd) = JST 00:00 相当）で比較可能
  const newSortKey = jstDate.getTime();

  switch (video.videoType) {
    case 'liveArchive':
      insertIntoArchiveSection(lines, secStart, secEnd, videoLine, year, month, newSortKey);
      break;
    case 'normal':
      insertIntoNormalSection(lines, secStart, secEnd, videoLine, year, newSortKey);
      break;
    case 'shorts':
      insertIntoShortsSection(lines, secStart, secEnd, videoLine, year, month, newSortKey);
      break;
    default:
      return null;
  }

  return lines.join('\n');
}
