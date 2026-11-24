import { zipRead } from './common-pack.js';
import { readScriptJa, planScriptJa } from './video-script-ja.js';

const english = row => Boolean(row.text?.match(/[A-Za-z]/)) && (!row.asr || row.aligned);
const stamp = text => {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
};
const manual = row => row.jaOverride || Boolean(row.ja);

async function inflateJaEntry(raw, expectedSize) {
  const { Inflate } = await import('./vendor/pako-inflate.js');
  const inflater = new Inflate({ raw: true });
  const chunks = [];
  let size = 0;
  inflater.onData = chunk => {
    size += chunk.length;
    if (size > expectedSize) throw Error('ZIPの展開サイズが一致しません');
    chunks.push(chunk);
  };
  const reader = raw.stream().getReader();
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (inflater.ended || !inflater.push(chunk.value, false)) throw Error('ZIP内の圧縮データを展開できません');
    }
    if (!inflater.ended && !inflater.push(new Uint8Array(), true)) throw Error('ZIP内の圧縮データを展開できません');
    if (size !== expectedSize) throw Error('ZIPの展開サイズが一致しません');
    return new Blob(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readStudioJaFiles(files) {
  const sections = [];
  const add = (name, text) => {
    const data = JSON.parse(text);
    readScriptJa(data, data?.materialId);
    sections.push({ name, data, index: sections.length });
  };
  for (const file of files) {
    try {
      const signature = new DataView(await file.slice(0, 4).arrayBuffer());
      const isZip = signature.byteLength === 4 && [0x04034b50, 0x06054b50].includes(signature.getUint32(0, true));
      if (isZip || /\.zip$/i.test(file.name.trim())) {
        const zip = await zipRead(file, { inflateFallback: inflateJaEntry });
        const names = zip.names.filter(name => /\.json$/i.test(name) && !/(?:^|\/)(?:__MACOSX|\._)/.test(name));
        if (!names.length) throw Error('ZIP内に英日対応JSONがありません');
        for (const name of names) {
          try { add(name, await zip.text(name)); } catch (error) { throw new Error(name + '：' + error.message); }
        }
      } else {
        add(file.name, await file.text());
      }
    } catch (error) { throw new Error(file.name + '：' + error.message); }
  }
  if (!sections.length) throw new Error('英日対応JSONがありません');
  return orderStudioJaSections(sections);
}

export function orderStudioJaSections(sections) {
  // A BEFORE interlude may explicitly identify its position in the ZIP filename.
  const position = section => {
    const after = section.name.match(/before[_ -]+after[_ -]+chapter[_ -]+(\d+)/i);
    if (after) return Number(after[1]) + .5;
    const chapter = String(section.data?.chapter ?? '').match(/^(?:chapter\s+)?(\d+)$/i);
    return chapter ? Number(chapter[1]) : 0;
  };
  return sections.map((section, index) => ({ ...section, index }))
    .sort((a, b) => position(a) - position(b) || a.index - b.index);
}

const englishChapter = text => {
  const header = text.trim().match(/^chapter\s+(\d+|[a-z-]+(?:\s+[a-z]+)?)$/i);
  if (!header) return null;
  if (/^\d+$/.test(header[1])) return String(Number(header[1]));
  const units = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  const [head, tail] = header[1].toLowerCase().split(/[-\s]+/);
  if (!tail && units.includes(head)) return String(units.indexOf(head));
  return tens.includes(head) && (!tail || units.indexOf(tail) > 0 && units.indexOf(tail) < 10) ?
    String(tens.indexOf(head) * 10 + (tail ? units.indexOf(tail) : 0)) : null;
};

export function studioJaView(blocks) {
  const rows = new Map(blocks.map(row => [row.id, row]));
  const good = new Map();
  for (const row of blocks) {
    const group = row.jaImport;
    if (!group?.members) continue;
    if (group.members.every(({ id, stamp: expected }) => {
      const member = rows.get(id);
      return member?.jaImport?.owner === row.id && stamp(member.text) === expected;
    })) good.set(row.id, group);
  }
  const value = row => !row ? '' : manual(row) ? row.ja || '' : good.get(row.jaImport?.owner)?.texts.join('\n') || '';
  const needsReview = row => Boolean(row && !manual(row) && (row.jaReview || (row.jaImport && !good.has(row.jaImport.owner))));
  const summary = { total: 0, applied: 0, review: [], missing: [] };
  for (const row of blocks.filter(english)) {
    summary.total++;
    if (needsReview(row)) summary.review.push(row);
    else if (value(row)) summary.applied++;
    else summary.missing.push(row);
  }
  const spans = [...good.values()].map(group => ({
    ids: group.members.map(x => x.id).filter(id => !manual(rows.get(id))),
    texts: group.texts,
  })).filter(group => group.ids.length);
  // A Studio manual edit or removal takes precedence over its imported group.
  for (const row of blocks) if (row.jaOverride && row.ja) spans.push({ ids: [row.id], texts: [row.ja] });
  return { value, needsReview, summary, spans };
}

export function planStudioJa(set, blocks, sections, { missingOnly = false } = {}) {
  const rows = sections.flatMap(({ data, index }) => {
    if (data?.materialId != null && data.materialId !== set.id) return [];
    const input = readScriptJa(data, set.id);
    return input.rows.map(row => ({ ...row, chapter: row.chapter || input.sourceChapter, section: index }));
  });
  const cues = blocks.filter(english).map(row => ({ id: row.id, en: row.text, chapter: englishChapter(row.text) }));
  const { patch, reviewCueIds } = planScriptJa(cues, { rows }, { allowUnknownChapters: true });
  const live = new Map(blocks.map(row => [row.id, row]));
  const missing = missingOnly ? new Set(studioJaView(blocks).summary.missing.map(row => row.id)) : null;
  const writable = id => !manual(live.get(id)) && (!missing || missing.has(id));
  const edits = new Map();
  const groups = new Map();
  for (const [id, entries] of patch) {
    // Blank translations in the shared file format are not a Studio delete instruction.
    if (!entries.length || !writable(id)) continue;
    const ids = entries[0].cueIds.filter(writable);
    const key = JSON.stringify(ids);
    if (!groups.has(key)) groups.set(key, { ids, texts: entries.map(entry => entry.ja) });
  }
  for (const { ids, texts } of groups.values()) {
    const owner = ids[0];
    const members = ids.map(id => ({ id, stamp: stamp(live.get(id).text) }));
    for (const id of ids) {
      const row = live.get(id);
      edits.set(id, { ...row, jaReview: false, jaImport: id === owner ? { owner, members, texts } : { owner } });
    }
  }
  for (const id of reviewCueIds) {
    const row = live.get(id);
    if (!edits.has(id) && writable(id) && !row.jaImport) edits.set(id, { ...row, jaReview: true });
  }
  const changes = blocks.map(row => edits.get(row.id) || row);
  return {
    changes: [...edits.values()].filter(row => {
      const old = live.get(row.id);
      return Boolean(row.jaReview) !== Boolean(old.jaReview) || JSON.stringify(row.jaImport) !== JSON.stringify(old.jaImport);
    }),
    summary: studioJaView(changes).summary,
  };
}
