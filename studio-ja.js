import { zipRead } from './common-pack.js';
import { normalizeScriptJa, readScriptJa, planScriptJa } from './video-script-ja.js';

const english = row => Boolean(row.text?.match(/[A-Za-z]/)) && (!row.asr || row.aligned);
const stamp = text => {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
};
const manual = row => row.jaOverride || Boolean(row.ja);

async function inflateJaEntry(raw, expectedSize) {
  const { Inflate } = await import('./pako-inflate.js');
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

// 1.19.31: one JSON may hold several chapters: [{ chapter, items }, …] or { chapters: [...] } / { sections: [...] }
const rowsOf = d => d && typeof d === 'object' && !Array.isArray(d) ? d.items ?? d.translations ?? d.cues : null;
export function jaJsonDocuments(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.chapters) ? data.chapters : Array.isArray(data?.sections) ? data.sections : null;
  if (list?.length && list.every(d => Array.isArray(rowsOf(d)))) return list.map(d => (data.materialId != null && d.materialId == null ? { ...d, materialId: data.materialId } : d));
  return [data];
}
export async function readStudioJaFiles(files) {
  const sections = [];
  const add = (name, text) => {
    const docs = jaJsonDocuments(JSON.parse(text));
    docs.forEach((data, i) => {
      try { readScriptJa(data, data?.materialId); }
      catch (error) { throw new Error(docs.length > 1 ? `${i + 1}番目の章：${error.message}` : error.message); }
      const label = docs.length > 1 ? `${name}#${data.chapter ?? i + 1}` : name;
      sections.push({ name: label, data, index: sections.length });
    });
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

// English–Japanese data pasted as text (a JSON with one or several chapters)
export async function readStudioJaText(text, name = '貼り付けたJSON.json') {
  const value = String(text || '').trim();
  if (!value) throw new Error('JSONを貼り付けてください');
  return readStudioJaFiles([new File([value], name, { type: 'application/json' })]);
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

export const englishChapter = text => {
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
  const needsReview = row => Boolean(row && !row.jaOverride && (row.jaStatus === 'needsReview' ||
    (!manual(row) && (row.jaReview || (row.jaImport && !good.has(row.jaImport.owner))))));
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

export function confirmStudioJa(row, ja) {
  return { ...row, ja: ja.trim(), jaOverride: true, jaReview: false, jaStatus: 'ok' };
}

export function studioJaChoices(set, sections) {
  return sections.flatMap(({ data, name }) => {
    if (data?.materialId != null && data.materialId !== set.id) return [];
    const { rows, sourceChapter } = readScriptJa(data, set.id);
    return rows.flatMap((row, i) => row.ja ? [{
      ...row, key: normalizeScriptJa(row.en), name: name.split('/').at(-1), chapter: row.chapter || sourceChapter,
      before: rows[i - 1]?.en, after: rows[i + 1]?.en,
    }] : []);
  });
}

export function findStudioJaChoices(choices, english, search = '', { before = '', after = '' } = {}) {
  const key = normalizeScriptJa(english), query = normalizeScriptJa(search);
  const prev = normalizeScriptJa(before), next = normalizeScriptJa(after);
  const words = new Set(key.split(' ').filter(word => word.length > 2));
  return choices.flatMap(choice => {
    if (query && !choice.key.includes(query) && !normalizeScriptJa(choice.ja).includes(query)) return [];
    const context = (prev && normalizeScriptJa(choice.before || '') === prev ? .2 : 0) +
      (next && normalizeScriptJa(choice.after || '') === next ? .2 : 0);
    if (choice.key === key) return [{ choice, score: 3 + context }];
    if (key && choice.key && ((' ' + choice.key + ' ').includes(' ' + key + ' ') ||
        (' ' + key + ' ').includes(' ' + choice.key + ' '))) return [{ choice, score: 2 + context }];
    const parts = new Set(choice.key.split(' ').filter(word => word.length > 2));
    const common = [...parts].filter(word => words.has(word)).length;
    const score = 2 * common / (parts.size + words.size || 1);
    return query || (common >= 2 && score >= .45) ? [{ choice, score: score + context }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, 10).map(result => result.choice);
}

// overwrite: false = rows that already have a translation (imported with the material, or fixed by hand) are kept;
// 'imported' = translations that came with the material / an earlier import are replaced too (hand corrections kept);
// 'all' = hand corrections are replaced as well. Only rows that the new data matches change; the others keep theirs.
export function planStudioJa(set, blocks, sections, { missingOnly = false, overwrite = false } = {}) {
  const rows = sections.flatMap(({ data, index }) => {
    if (data?.materialId != null && data.materialId !== set.id) return [];
    const input = readScriptJa(data, set.id);
    return input.rows.map(row => ({ ...row, chapter: row.chapter || input.sourceChapter, section: index }));
  });
  const cues = blocks.filter(english).map(row => ({ id: row.id, en: row.text, chapter: englishChapter(row.text) }));
  const { patch, reviewCueIds } = planScriptJa(cues, { rows }, { allowUnknownChapters: true });
  const live = new Map(blocks.map(row => [row.id, row]));
  const missing = missingOnly ? new Set(studioJaView(blocks).summary.missing.map(row => row.id)) : null;
  // 1.19.30: a shared translation fixed by hand (jaImport.manual) is protected like a manual row
  const handGroup = row => Boolean(row?.jaImport && live.get(row.jaImport.owner)?.jaImport?.manual);
  const hand = row => Boolean(row?.jaOverride) || handGroup(row);
  const writable = id => {
    const row = live.get(id);
    if (missing && !missing.has(id)) return false;
    if (overwrite === 'all') return true;
    if (overwrite === 'imported') return !hand(row);
    return !manual(row) && !handGroup(row);
  };
  // a row that is overwritten drops its own text so the imported group is what it shows
  const clean = row => { if (!row.ja && !row.jaOverride) return row; const { jaOverride, ...rest } = row; return { ...rest, ja: '' }; };
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
      edits.set(id, { ...clean(row), ...(row.jaStatus === 'needsReview' && { jaStatus: 'ok' }),
        jaReview: false, jaImport: id === owner ? { owner, members, texts } : { owner } });
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
      return Boolean(row.jaReview) !== Boolean(old.jaReview) || row.jaStatus !== old.jaStatus ||
        JSON.stringify(row.jaImport) !== JSON.stringify(old.jaImport) || (row.ja || '') !== (old.ja || '') ||
        Boolean(row.jaOverride) !== Boolean(old.jaOverride);
    }),
    summary: studioJaView(changes).summary,
  };
}

// ================= 1.19.30: position editor (shared with Video Lab through ja-position.js) =================
export const studioJaLocked = (row, rows) => manual(row) || Boolean(row?.jaImport && rows.get(row.jaImport.owner)?.jaImport?.manual);
// rows for the editor: own = a hand translation (or an imported one used by this row only); groups = imported/hand
// translations shared by several rows (kept as one group, never copied to each row).
export function studioJaRows(blocks, list = blocks) {
  const view = studioJaView(blocks), byId = new Map(blocks.map(row => [row.id, row]));
  const groups = new Map();
  const rows = list.map(row => {
    if (manual(row)) return { id: row.id, en: row.text || '', own: row.ja || '', groups: [] };
    const owner = row.jaImport?.owner && byId.get(row.jaImport.owner);
    const group = owner?.jaImport?.members && view.value(row) ? owner.jaImport : null;
    const members = group ? group.members.map(m => m.id).filter(id => byId.has(id) && !manual(byId.get(id))) : [];
    if (group && members.length > 1) {
      if (!groups.has(owner.id)) groups.set(owner.id, { text: group.texts.join('\n'), members, hand: Boolean(group.manual) });
      return { id: row.id, en: row.text || '', own: '', groups: [owner.id] };
    }
    return { id: row.id, en: row.text || '', own: view.value(row) || '', groups: [] };
  });
  return { rows, groups };
}
// editor changes -> block states for one commit (one undo step). Rows that keep a shared group are untouched.
export function studioJaEditBlocks(blocks, changes) {
  const byId = new Map(blocks.map(row => [row.id, row]));
  return changes.map(change => {
    const row = byId.get(change.id);
    if (!row) throw new Error('行が見つかりません');
    if (change.after.groups.length) throw new Error('共有訳を残したまま個別の訳は保存できません');
    return confirmStudioJa(row, change.after.own);
  });
}
// A translation shared by several rows, set by hand (from Video Lab or a correction file): protected from re-matching.
export function studioHandGroup(rows, texts) {
  const owner = rows[0].id;
  const members = rows.map(row => ({ id: row.id, stamp: stamp(row.text) }));
  return rows.map(row => {
    const { jaOverride, ...rest } = row;
    return { ...rest, ja: '', jaReview: false, jaStatus: 'ok', jaImport: row.id === owner ? { owner, members, texts, manual: true } : { owner } };
  });
}
export const studioJaManual = manual;
// Write translation units [{ ids: [block ids in reading order], texts: [ja] }] as hand corrections:
// one id -> manual row (empty texts = explicit removal), several ids -> one hand-made shared translation.
// A group whose owner is rewritten keeps its other members' text (they become manual) so no row silently loses it.
export function studioPatchUnits(blocks, units) {
  const byId = new Map(blocks.map(row => [row.id, row])), out = new Map();
  for (const unit of units) {
    const rows = unit.ids.map(id => byId.get(id));
    if (rows.some(row => !row)) throw new Error('行が見つかりません');
    if (rows.length === 1) out.set(rows[0].id, confirmStudioJa(rows[0], unit.texts.filter(Boolean).join('\n')));
    else for (const row of studioHandGroup(rows, unit.texts.filter(Boolean))) out.set(row.id, row);
  }
  const view = studioJaView(blocks);
  for (const row of blocks) {
    const owner = row.jaImport?.owner;
    if (!owner || owner === row.id || out.has(row.id) || !out.has(owner) || manual(row)) continue;
    if (out.get(owner).jaImport?.owner === owner && out.get(owner).jaImport.members?.some(m => m.id === row.id)) continue;
    const text = view.value(row);
    if (text) out.set(row.id, confirmStudioJa(row, text));
  }
  return [...out.values()];
}
