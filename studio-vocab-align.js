import { words } from './studio-align.js';

// Match a whole recognised unit. Punctuation affects neither the key nor the displayed script.
export const vocabKey = text => words(text).map(word => word.w).join(' ');
export const isVocabTarget = row => !row.deleted && !row.asr && !row.segments.length &&
  row.sync !== 'manual' && Boolean(vocabKey(row.text));
const overlaps = (a, b) => a.sourceId === b.sourceId && a.start < b.end && a.end > b.start;
const isHead = row => row.kind === 'word' || (row.kind !== 'example' && vocabKey(row.text).split(' ').length <= 2);

export function planVocabAlignment(rows, evidence, occupied, { targets = null } = {}) {
  const groups = [];
  for (const row of rows) {
    const key = vocabKey(row.text);
    if (!key) continue;
    const previous = groups.at(-1);
    if (!isHead(row) && previous?.key === key && !isHead(previous.rows[0]) &&
        previous.rows.every(isVocabTarget) && isVocabTarget(row) && !row.rep) previous.rows.push(row);
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
  for (const cue of evidence) {
    const key = vocabKey(cue.text);
    if (!key || cue.estimated || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
        cue.start < 0 || cue.end - cue.start < .06 ||
        blocked.get(cue.sourceId)?.some(range => overlaps(cue, range))) continue;
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
      const implicitRepeat = requested === 1 && hits.length === 2 && enclosed && !isHead(group.rows[0]) &&
        before.index === index - 1 && after.index === index + 1 && isHead(groups[index - 1].rows.at(-1)) && isHead(groups[index + 1].rows[0]);
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
      group.rows.forEach((row, i) => proposals.push({
        row, cues: group.rows.length === 1 ? hits : [hits[i]],
      }));
      added++;
    }
    if (!added) break;
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
