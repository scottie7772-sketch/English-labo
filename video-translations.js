const key = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function csvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (quoted || !cell)) {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(cell.trim()); cell = '';
      if (ch === '\n') { rows.push(row); row = []; }
    } else cell += ch;
  }
  if (quoted) throw new Error('CSVの引用符を確認してください');
  rows.push([...row, cell.trim()]);
  return rows.filter(cells => cells.some(Boolean));
}

export function translationRows(input) {
  const text = input.trim().replace(/\r\n?/g, '\n');
  if (/^[\[{]/.test(text)) {
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : data.items ?? data.cues;
    if (!Array.isArray(rows)) throw new Error('JSONの配列または items / cues を指定してください');
    return rows.map(row => typeof row === 'string' ? { ja: row } : {
      en: row.en ?? row.english ?? row.text, ja: row.ja ?? row.japanese ?? row.translation, cue: row.cue ?? row.row,
    });
  }
  const lines = text.split('\n').filter(line => line.trim());
  let cells = lines.some(line => line.includes('\t')) ? lines.map(line => line.split('\t').map(v => v.trim())) :
    /^(?:"?(?:en|english|英文|英語|cue|row|字幕行|ja|日本語訳)"?,)|^"/i.test(text) ? csvRows(text) : null;
  if (!cells) {
    const blocks = text.split(/\n\s*\n/).map(block => block.split('\n'));
    if (blocks.every(([en, ja]) => /[a-z]/i.test(en) && /[ぁ-龯]/.test(ja || ''))) {
      return blocks.map(([en, ...ja]) => ({ en, ja: ja.join('\n') }));
    }
    return lines.map(ja => ({ ja }));
  }
  const header = cells[0].map(key);
  const ja = header.findIndex(x => /^(ja|japanese|translation|日本語訳?|和訳)$/.test(x));
  if (ja < 0) return cells.map(([en, ja]) => ({ en, ja }));
  const en = header.findIndex(x => /^(en|english|英文|英語)$/.test(x));
  const cue = header.findIndex(x => /^(cue|row|字幕行)$/.test(x));
  return cells.slice(1).map(row => ({ en: row[en], ja: row[ja], cue: row[cue] }));
}

export function planTranslations(cues, rows) {
  const changes = new Map(), unmatched = [];
  const keys = cues.map(cue => key(cue.en));
  const starts = new Map();
  keys.forEach((k, i) => {
    const first = k.split(' ')[0];
    if (!starts.has(first)) starts.set(first, []);
    starts.get(first).push(i);
  });
  const positional = cues.length === rows.length && rows.every(row => !row.en && !row.cue && row.start == null);
  rows.forEach((row, index) => {
    let matches = [];
    if (row.cue) {
      const m = String(row.cue).match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
      if (m) {
        const first = +m[1], last = +(m[2] || first);
        if (first >= 1 && last >= first && last <= cues.length) matches = cues.slice(first - 1, last);
      }
    } else if (row.start != null) {
      const overlaps = cues.map(cue => Math.min(cue.end, row.end) - Math.max(cue.start, row.start));
      const best = overlaps.reduce((a, b) => Math.max(a, b), 0);
      if (best > 0 && overlaps.filter(x => x === best).length === 1) matches = [cues[overlaps.indexOf(best)]];
    } else if (row.en) {
      const wanted = key(row.en), found = [];
      if (wanted) for (const i of starts.get(wanted.split(' ')[0]) || []) {
        let combined = '';
        for (let j = i; j < keys.length && keys[j]; j++) {
          combined = combined ? combined + ' ' + keys[j] : keys[j];
          if (wanted === combined) { found.push(cues.slice(i, j + 1)); break; }
          if (!wanted.startsWith(combined + ' ')) break;
        }
      }
      if (found.length === 1) matches = found[0];
    } else if (positional) matches = [cues[index]];
    if (!matches.length || typeof row.ja !== 'string' || !row.ja.trim()) { unmatched.push(index + 1); return; }
    for (const cue of matches) {
      const previous = changes.get(cue.id);
      changes.set(cue.id, {
        ...cue,
        ja: previous ? previous.ja + '\n' + row.ja.trim() : row.ja.trim(),
        jaEdited: true,
      });
    }
  });
  return { changes, unmatched, positional };
}
