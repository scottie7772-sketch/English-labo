// Match only complete consecutive spans. The output contains cue IDs and Japanese text.
const normalize = text => text.normalize('NFKC').toLowerCase()
  .replace(/[’‘ʼ]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)?.join(' ') || '';
const chapterKey = value => {
  const label = String(value ?? '').normalize('NFKC').trim();
  const match = label.match(/^(?:chapter\s+0*(\d+)|第\s*0*(\d+)\s*章|0*(\d+)|before)$/i);
  return match ? (match[1] || match[2] || match[3] || 'before') : null;
};
const heading = s => /^(?:chapter\s+\d+|第\s*\d+\s*章|BEFORE)[.!:]?$/i.test(s.normalize('NFKC').trim());

export function readScriptJa(data, materialId, title = '') {
  if (!data || typeof data !== 'object') throw new Error('英文と訳文のJSONを指定してください');
  if (data.materialId != null && data.materialId !== materialId) throw new Error('教材IDが一致しません');
  const rows = Array.isArray(data) ? data : data.items ?? data.translations ?? data.cues;
  if (!Array.isArray(rows) || !rows.length) throw new Error('英文と訳文を配列で指定してください');
  const titleChapter = title.normalize('NFKC').match(/(?:^|[^a-z])chapter[ _-]+(\d+)(?!\d)|第\s*(\d+)\s*章/i);
  const seriesTitle = /\d\s*[-–—〜～~]\s*\d/.test(title);
  const targetChapter = !seriesTitle && titleChapter ? chapterKey(titleChapter[1] || titleChapter[2]) : null;
  const sourceChapter = chapterKey(data.chapter);
  if (data.chapter != null && !sourceChapter) throw new Error('chapter は章番号または BEFORE を指定してください');
  if (sourceChapter && targetChapter && sourceChapter !== targetChapter) throw new Error('章が一致しません');
  return { sourceChapter, targetChapter, rows: rows.map((row, index) => {
    const en = row?.en ?? row?.english ?? row?.text;
    const ja = row?.ja ?? row?.japanese ?? row?.translation;
    const chapter = chapterKey(row?.chapter);
    if (!(typeof en === 'string' || (Array.isArray(en) && en.every(s => typeof s === 'string'))) ||
        typeof ja !== 'string' || (row?.chapter != null && !chapter)) throw new Error(`入力 ${index + 1}件目の英文・訳文・章を確認してください`);
    return { en: Array.isArray(en) ? en.join(' ') : en, ja: ja.trim(), chapter };
  }) };
}

const compatible = (a, b) => !a || !b || a === b;
const materialRows = (items, initialChapter) => {
  let chapter = initialChapter;
  return items.map(item => {
    const isHeading = heading(item.en || '');
    if (item.chapter || isHeading) chapter = item.chapter || chapterKey((item.en || '').trim().replace(/[.!:]$/, ''));
    return { ...item, chapter, key: normalize(item.en || ''), isHeading };
  });
};

export function planScriptJa(cues, input) {
  const source = materialRows(input.rows, input.sourceChapter);
  const target = materialRows(cues, input.targetChapter);
  const starts = new Map();
  const hasTargetChapters = target.some(row => row.chapter);
  target.forEach((row, i) => {
    const word = row.key.split(' ')[0];
    if (!word) return;
    if (!starts.has(word)) starts.set(word, []);
    starts.get(word).push(i);
  });
  const frequency = rows => {
    const out = new Map();
    for (const { key } of rows) out.set(key, (out.get(key) || 0) + 1);
    return out;
  };
  const sourceFrequency = frequency(source), targetFrequency = frequency(target);
  const matches = [], byRow = source.map(() => []), byCue = target.map(() => []);
  const canJoin = (rows, first, last) => last < rows.length && last - first < 8 &&
    !rows[first].isHeading && !rows[last].isHeading && rows[first].chapter === rows[last].chapter && Boolean(rows[last].key);
  for (const [s, row] of source.entries()) {
    if (!row.key || sourceFrequency.get(row.key) > 64 || targetFrequency.get(row.key) > 64) continue;
    for (const c of starts.get(row.key.split(' ')[0]) || []) {
      if ((row.chapter && hasTargetChapters && row.chapter !== target[c].chapter) || !compatible(row.chapter, target[c].chapter) || row.isHeading !== target[c].isHeading) continue;
      let a = s, b = c, left = row.key, right = target[c].key;
      while (left !== right) {
        if (right.startsWith(left + ' ') && canJoin(source, s, a + 1)) left += ' ' + source[++a].key;
        else if (left.startsWith(right + ' ') && canJoin(target, c, b + 1)) right += ' ' + target[++b].key;
        else break;
      }
      if (left !== right) continue;
      const match = { s, a, c, b };
      matches.push(match);
      for (let i = s; i <= a; i++) byRow[i].push(match);
      for (let i = c; i <= b; i++) byCue[i].push(match);
    }
  }
  // Only non-crossing, independently unique matches can bracket repetitions.
  const unique = matches.filter(m => byRow.slice(m.s, m.a + 1).every(h => h.length === 1) &&
    byCue.slice(m.c, m.b + 1).every(h => h.length === 1));
  const after = Array(unique.length);
  let earliest = Infinity;
  for (let i = unique.length - 1; i >= 0; i--) { after[i] = earliest; earliest = Math.min(earliest, unique[i].c); }
  let latest = -1;
  const accepted = [];
  for (const [i, m] of unique.entries()) {
    if (m.c > latest && m.b < after[i]) accepted.push(m);
    latest = Math.max(latest, m.b);
  }
  const contextual = [];
  for (let i = 1; i < accepted.length; i++) {
    const previous = accepted[i - 1], next = accepted[i];
    if (next.s - previous.a > 1 && next.s - previous.a <= 9) {
      let s = previous.a + 1, c = previous.b + 1;
      const path = [];
      while (s < next.s && c < next.c) {
        const choices = byRow[s].filter(m => m.s === s && m.c === c && m.a < next.s && m.b < next.c &&
          !source[m.s].isHeading && !target[m.c].isHeading &&
          source[m.s].chapter === source[previous.a].chapter && source[m.a].chapter === source[next.s].chapter &&
          target[m.c].chapter === target[previous.b].chapter && target[m.b].chapter === target[next.c].chapter);
        if (choices.length !== 1) break;
        const m = choices[0]; path.push(m); s = m.a + 1; c = m.b + 1;
      }
      if (s === next.s && c === next.c) { contextual.push(...path); continue; }
    }
    const local = [];
    const span = Math.min(next.s, previous.a + 9);
    for (let j = previous.a + 1; j < span; j++) {
      const possibilities = byRow[j].filter(m => m.s === j && m.a < next.s &&
        m.c > previous.b && m.b < next.c &&
        source[m.s].chapter === source[previous.a].chapter && source[m.a].chapter === source[next.s].chapter &&
        target[m.c].chapter === target[previous.b].chapter && target[m.b].chapter === target[next.c].chapter);
      if (possibilities.length !== 1) continue;
      const m = possibilities[0];
      if (j === previous.a + 1 && m.c === previous.b + 1 ||
          m.a === next.s - 1 && m.b === next.c - 1) local.push(m);
    }
    for (const m of local) {
      if (!local.some(other => other !== m &&
        ((m.s <= other.a && other.s <= m.a) || (m.s < other.s ? m.b >= other.c : other.b >= m.c)))) contextual.push(m);
    }
  }
  const patch = new Map(), covered = new Set();
  for (const m of [...accepted, ...contextual]) {
    const values = source.slice(m.s, m.a + 1).map(row => row.ja);
    if (values.some(Boolean) && values.some(ja => !ja)) continue;
    const cueIds = target.slice(m.c, m.b + 1).map(c => c.id).sort();
    const group = [...new Set(values.filter(Boolean))].map(ja => ({ ja, cueIds }));
    for (const id of cueIds) patch.set(id, group);
    for (let i = m.s; i <= m.a; i++) covered.add(i);
  }
  return { patch, review: source.flatMap((row, i) => covered.has(i) ? [] : [{
    number: i + 1, en: row.en, ja: row.ja, reason: byRow[i].length ? '複数候補・順序の矛盾・削除範囲の混在' : '一致する字幕が見つかりません',
  }]) };
}
