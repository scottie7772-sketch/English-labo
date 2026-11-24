// 1.19.30: compare / reflect translations between a Studio set and the Video Lab materials made from it.
// Only translations are written: no speech recognition, matching or material creation is run again, no audio is read.
// Nothing is synchronised automatically: the user picks the direction, the targets and every unit.
import { studioJaView, studioJaManual, studioPatchUnits } from './studio-ja.js';
import { labJaEntries, cueStamps } from './video-ja.js';

const textOf = entries => entries.map(e => e.ja).join('\n');

// Studio translation structure per block id: { text, entries: [{ ja, ids }] , group: key|null, hand }
function studioStructure(blocks) {
  const view = studioJaView(blocks), byId = new Map(blocks.map(b => [b.id, b]));
  const out = new Map();
  for (const b of blocks) {
    if (studioJaManual(b)) { out.set(b.id, { text: b.ja || '', texts: b.ja ? [b.ja] : [], group: null, members: [b.id], manual: true }); continue; }
    const owner = b.jaImport?.owner && byId.get(b.jaImport.owner);
    const value = view.value(b);
    if (value && owner?.jaImport?.members) {
      const members = owner.jaImport.members.map(m => m.id).filter(id => byId.has(id) && !studioJaManual(byId.get(id)));
      out.set(b.id, { text: value, texts: owner.jaImport.texts.slice(), group: members.length > 1 ? owner.id : null, members: members.length > 1 ? members : [b.id], manual: Boolean(owner.jaImport.manual) });
    } else out.set(b.id, { text: value || '', texts: value ? [value] : [], group: null, members: [b.id], manual: false });
  }
  return out;
}

// units: rows tied together by a shared translation on either side are compared and written together.
export function compareStudioLab(blocks, cues, records) {
  const studio = studioStructure(blocks), byBlock = new Map(blocks.map(b => [b.id, b]));
  const lab = labJaEntries(cues, records);
  const cueOf = new Map(cues.filter(c => c.itemId && byBlock.has(c.itemId)).map(c => [c.itemId, c]));
  const blockOf = new Map(cues.filter(c => c.itemId).map(c => [c.id, c.itemId]));
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  for (const id of cueOf.keys()) parent.set(id, id);
  for (const [id, s] of studio) if (cueOf.has(id)) for (const m of s.members) if (cueOf.has(m)) union(id, m);
  for (const [id, c] of cueOf) for (const e of lab.get(c.id).entries) for (const cid of e.cueIds) { const bid = blockOf.get(cid); if (bid && cueOf.has(bid)) union(id, bid); }
  const groups = new Map();
  for (const b of blocks) if (cueOf.has(b.id)) { const r = find(b.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(b.id); }
  const units = [];
  for (const ids of groups.values()) {
    const rows = ids.map(id => {
      const block = byBlock.get(id), cue = cueOf.get(id), s = studio.get(id), l = lab.get(cue.id);
      const L = textOf(l.entries), S = s.text, link = l.link;
      const base = link ? (link.base ?? (link.studio ? L : null)) : L;
      const labChanged = base == null ? true : L !== base;
      const studioChanged = base == null ? (s.manual || studioJaManual(block)) : S !== base;
      return { blockId: id, cueId: cue.id, en: block.text, enMatch: (cue.en || '') === (block.text || ''), S, L, base, labChanged, studioChanged,
        labShared: l.entries.some(e => e.cueIds.length > 1), labMixed: l.entries.some(e => e.cueIds.length > 1) && l.entries.some(e => e.cueIds.length === 1) };
    });
    const differ = rows.some(r => r.S !== r.L);
    let status = 'same';
    if (rows.some(r => !r.enMatch)) status = 'en';
    else if (differ) {
      const lc = rows.some(r => r.S !== r.L && r.labChanged), sc = rows.some(r => r.S !== r.L && r.studioChanged);
      status = lc && sc ? 'conflict' : lc ? 'toStudio' : sc ? 'toLab' : 'conflict';
    }
    units.push({ ids, rows, status, mixed: rows.some(r => r.labMixed) });
  }
  return units;
}

// Studio -> Lab: the selected units take the Studio translations (as Studio-origin links with the agreed text as base).
export function studioToLabChanges(blocks, cues, records, units) {
  const studio = studioStructure(blocks), lab = labJaEntries(cues, records);
  const cueOf = new Map(cues.filter(c => c.itemId).map(c => [c.itemId, c]));
  const changes = [], base = new Map();
  for (const unit of units) for (const id of unit.ids) {
    const s = studio.get(id), cue = cueOf.get(id);
    const cueIds = s.group ? s.members.map(m => cueOf.get(m)?.id).filter(Boolean).sort() : [cue.id];
    const after = s.texts.filter(t => t.trim()).map(ja => ({ ja, cueIds }));
    changes.push({ cueId: cue.id, before: lab.get(cue.id).entries, after });
    base.set(cue.id, s.text);
  }
  return { changes, base, expected: cueStamps(cues) };
}

// Lab -> Studio: block states for one Studio commit (one undo step). Lab shared translations stay shared (hand group).
export function labToStudioBlocks(blocks, cues, records, units) {
  const lab = labJaEntries(cues, records), order = new Map(blocks.map((b, i) => [b.id, i]));
  const cueOf = new Map(cues.filter(c => c.itemId).map(c => [c.itemId, c]));
  const blockOfCue = new Map(cues.filter(c => c.itemId).map(c => [c.id, c.itemId]));
  const patch = [], base = new Map(), done = new Set();
  for (const unit of units) {
    if (unit.mixed) throw new Error('個別の訳と共有訳が混在している字幕があります。Labの位置調整で整理してから反映してください');
    for (const id of unit.ids) {
      const cue = cueOf.get(id), entries = lab.get(cue.id).entries;
      base.set(cue.id, entries.map(e => e.ja).join('\n'));
      const shared = entries.find(e => e.cueIds.length > 1);
      if (!shared) { patch.push({ ids: [id], texts: entries.map(e => e.ja) }); continue; }
      const key = JSON.stringify(shared.cueIds);
      if (done.has(key)) continue;
      done.add(key);
      const ids = shared.cueIds.map(cid => blockOfCue.get(cid));
      if (ids.some(x => !x || !order.has(x))) throw new Error('共有訳の一部の字幕がスタジオにありません');
      ids.sort((a, b) => order.get(a) - order.get(b));
      patch.push({ ids, texts: entries.filter(e => JSON.stringify(e.cueIds) === key).map(e => e.ja) });
    }
  }
  return { blocks: studioPatchUnits(blocks, patch), base };
}

// After Lab -> Studio: the Lab side keeps its translations and only records the agreed text (for the next comparison).
export function labAgreedChanges(cues, records, units) {
  const lab = labJaEntries(cues, records);
  return units.flatMap(u => u.rows.map(r => ({ cueId: r.cueId, before: lab.get(r.cueId).entries, after: lab.get(r.cueId).entries })));
}

export const SYNC_STATUS = { same: '一致', toLab: 'スタジオ側が新しい', toStudio: 'Lab側が新しい', conflict: '競合（双方で変更）', en: '英文が異なる（対象外）' };
