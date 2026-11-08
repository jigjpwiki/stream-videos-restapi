// Numeric references prevent Wiki syntax and line injection, including control characters.
export function escapeName(name) {
  return [...name].map(c => /[\p{L}\p{N} ]/u.test(c) ? c : `&#${c.codePointAt(0)};`).join('');
}
export function formatRows(rows, empty) {
  if (!rows.length) return `CENTER:${empty}`;
  return rows.map(row => {
    const time = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(row.date)).replace(':', '時') + '分～';
    const icon = row.platform === 'youtube' ? 'youtube,#ff0033' : 'twitch,#9246ff';
    if (row.facePage && !/^[\p{L}\p{N} _・ー。]+\/face\.png$/u.test(row.facePage)) throw new Error('Unsafe face path');
    const face = row.facePage ? `&ref(${row.facePage},nolink,25x25); ` : '';
    return `-&fa(fa-brands fa-${icon}); ${time} ${face}[[${escapeName(row.name)}>${row.url}]]`;
  }).join('\n');
}
export const markers = ['// JIGWIKI_LIVE_BEGIN', '// JIGWIKI_LIVE_END', '// JIGWIKI_UPCOMING_BEGIN', '// JIGWIKI_UPCOMING_END'];
export function replaceSections(source, sections) {
  const positions = markers.map(marker => {
    if (source.split(marker).length !== 2) throw new Error('Missing or duplicate Wiki marker');
    const at = source.indexOf(marker);
    if (at > 0 && source[at - 1] !== '\n') throw new Error('Wiki marker must occupy its own line');
    if (!(source.startsWith('\n', at + marker.length) || source.startsWith('\r\n', at + marker.length))) throw new Error('Wiki marker must occupy its own line');
    return at;
  });
  if (!positions.every((p, i) => !i || p > positions[i - 1])) throw new Error('Incorrect Wiki marker order');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let result = source;
  for (const [i, content] of [[2, formatRows(sections.upcoming, 'このあと配信予定はありません')], [0, formatRows(sections.live, '現在、配信中の配信はありません')]]) {
    const start = positions[i] + markers[i].length + newline.length;
    result = result.slice(0, start) + content.replaceAll('\n', newline) + newline + result.slice(positions[i + 1]);
  }
  return result;
}
