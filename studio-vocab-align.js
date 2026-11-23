import { similarity } from './studio-import-align.js';
import { words } from './studio-align.js';

// Match a whole recognised unit. Punctuation affects neither the key nor the displayed script.
export const vocabKey = text => words(text).map(word => word.w).join(' ');
export const isVocabTarget = row => !row.deleted && !row.asr && !row.segments.length &&
  row.sync !== 'manual' && Boolean(vocabKey(row.text));
const overlaps = (a, b) => a.sourceId === b.sourceId && a.start < b.end && a.end > b.start;
export const isVocabHead = row => row.kind === 'word' || (row.kind !== 'example' &&
  !/[.!?]$/.test(row.text.trim()) && vocabKey(row.text).split(' ').length <= 2);

export function planVocabAlignment(rows, evidence, occupied, { targets = null } = {}) {
  const groups = [];
  for (const row of rows) {
    const key = vocabKey(row.text);
    if (!key) continue;
    const previous = groups.at(-1);
    if (!isVocabHead(row) && previous?.key === key && !isVocabHead(previous.rows[0]) &&
        previous.rows.every(isVocabTarget) && isVocabTarget(row) && !row.rep &&
        !row.label && !row.holes?.length && (!row.ja || row.ja === previous.rows[0].ja) &&
        (!targets || (targets.has(row.id) && previous.rows.every(item => targets.has(item.id))))) previous.rows.push(row);
    else groups.push({key, rows:[row]});
  }
  const indexed = new Map(), used = new Set(), proposals = [];
  const groupCount = new Map();
  for (const group of groups) groupCount.set(group.key, (groupCount.get(group.key) || 0) + 1);
  const blocked = new Map();
  for (const range of occupied) {
    if (!blocked.has(range.sourceId)) blocked.set(range.sourceId, []);
    blocked.get(range.sourceId).push(range);
  }
  const longGroups = groups.filter(group => !isVocabHead(group.rows[0]) && group.key.split(' ').length >= 6);
  for (const cue of evidence) {
    let key = vocabKey(cue.text);
    if (!key || cue.estimated || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
        cue.start < 0 || cue.end - cue.start < .06 ||
        blocked.get(cue.sourceId)?.some(range => overlaps(cue, range))) continue;
    if (!groupCount.has(key) && key.split(' ').length >= 5) {
      const near = longGroups.filter(group =>
        Math.abs(group.key.split(' ').length - key.split(' ').length) <= 1 && similarity(group.key, key) >= .85);
      if (near.length === 1) key = near[0].key;
    }
    if (!indexed.has(key)) indexed.set(key, []);
    indexed.get(key).push(cue);
  }
  const anchors = groups.map(group => group.rows.flatMap(row => row.segments));
  // First use unambiguous whole rows, then use their order to resolve repetitions.
  for (let pass = 0; pass < 3; pass++) {
    const bySource = new Map();
    anchors.forEach((ranges, index) => {
      for (const range of ranges) {
        if (!bySource.has(range.sourceId)) bySource.set(range.sourceId, []);
        const list = bySource.get(range.sourceId);
        const last = list.at(-1);
        if (last?.index === index) {
          last.start = Math.min(last.start, range.start);
          last.end = Math.max(last.end, range.end);
        } else list.push({index, start:range.start, end:range.end});
      }
    });
    const boundsFor = (sourceId, index) => {
      const list = bySource.get(sourceId) || [];
      let low = 0, high = list.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (list[middle].index < index) low = middle + 1;
        else high = middle;
      }
      return {before:list[low - 1], after:list[low]};
    };
    const candidates = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (anchors[index].length || !group.rows.every(row => isVocabTarget(row) && (!targets || targets.has(row.id)))) continue;
      const hits = (indexed.get(group.key) || []).filter(cue => {
        const {before, after} = boundsFor(cue.sourceId, index);
        return !used.has(cue) && (!before || cue.start >= before.end) && (!after || cue.end <= after.start);
      }).sort((a, b) => a.start - b.start);
      if (!hits.length || hits.some(hit => hit.sourceId !== hits[0].sourceId)) continue;
      const {before, after} = boundsFor(hits[0].sourceId, index);
      const enclosed = Boolean(before && after);
      if (groupCount.get(group.key) > 1 && !enclosed) continue;
      const requested = group.rows.length > 1 ? group.rows.length : group.rows[0].rep || 1;
      const implicitRepeat = !isVocabHead(group.rows[0]) &&
        hits.length > requested && groupCount.get(group.key) === 1 &&
        (!before || before.index === index - 1) && (!after || after.index === index + 1);
      if (hits.length !== requested && !implicitRepeat) continue;
      if (hits.some((hit, i) => i && (hit.start < hits[i - 1].end || hit.start - hits[i - 1].end > 4))) continue;
      candidates.push({index, group, hits});
    }
    // Reject contradictory candidates in script order before any can be saved.
    const crossed = new Set(), lastBySource = new Map();
    for (const candidate of candidates) {
      const first = candidate.hits[0], last = lastBySource.get(first.sourceId);
      if (last && first.start < last.hits.at(-1).end) {
        crossed.add(last);
        crossed.add(candidate);
      }
      if (!last || candidate.hits.at(-1).end > last.hits.at(-1).end) lastBySource.set(first.sourceId, candidate);
    }
    let added = 0;
    for (const candidate of candidates) {
      if (crossed.has(candidate) || candidate.hits.some(hit => used.has(hit))) continue;
      const {group, hits, index} = candidate;
      anchors[index] = hits;
      hits.forEach(hit => used.add(hit));
      proposals.push({ row: group.rows[0], cues: hits, redundant: group.rows.slice(1) });
      added++;
    }
    if (!added) break;
  }
  // A single independent VAD region between consecutive anchors is a preview,
  // never an exact recognition. Do not infer from conflicting recognised words.
  const sourceEvidence = new Map();
  for (const cue of evidence) {
    if (!sourceEvidence.has(cue.sourceId)) sourceEvidence.set(cue.sourceId, []);
    sourceEvidence.get(cue.sourceId).push(cue);
  }
  for (let i = 1; i + 1 < groups.length; i++) {
    const { rows: [row, duplicate] } = groups[i];
    if (duplicate || anchors[i].length || !isVocabHead(row) ||
        !isVocabTarget(row) || (targets && !targets.has(row.id))) continue;
    const left = anchors[i - 1].at(-1), right = anchors[i + 1][0];
    if (!left || !right || left.sourceId !== right.sourceId || right.start - left.end > 6) continue;
    const between = (sourceEvidence.get(left.sourceId) || []).filter(cue =>
      cue.start < right.start && cue.end > left.end && !used.has(cue));
    if (between.length !== 1) continue;
    const [cue] = between;
    if (!cue.vad || vocabKey(cue.text) || cue.start < left.end || cue.end > right.start ||
        cue.end - cue.start < .12 || cue.end - cue.start > 2 ||
        blocked.get(cue.sourceId)?.some(span => overlaps(span, cue))) continue;
    proposals.push({ row, cues: [cue], estimated: true });
  }
  const order = new Map(rows.map((row, i) => [row.id, i]));
  return proposals.sort((a, b) => order.get(a.row.id) - order.get(b.row.id));
}

export function unassignedVocabRanges(occupied, start, end, minimum = .2) {
  const ranges = [];
  let cursor = start;
  for (const range of occupied.slice().sort((a, b) => a.start - b.start)) {
    if (range.end <= cursor || range.start >= end) continue;
    if (range.start - cursor >= minimum) ranges.push({start:cursor,end:range.start});
    cursor = Math.min(end, Math.max(cursor, range.end));
  }
  if (end - cursor >= minimum) ranges.push({start:cursor,end});
  return ranges;
}
