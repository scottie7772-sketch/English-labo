import { words } from './studio-align.js';

const key = text => words(text).map(word => word.w).join(' ');
const valid = g => g.sourceId && Number.isFinite(g.start) && Number.isFinite(g.end) && g.start >= 0 && g.end > g.start;
const script = b => Boolean(b.text?.trim()) && (!b.asr || b.aligned || b.sync === 'manual');
const missing = b => !b.segments.length && b.sync !== 'manual';
export const sameRescueVersion = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function rescuePreviewRange(start, end, duration, part = 'all') {
  if (![start, end].every(Number.isFinite) || start < 0) return null;
  const limit = Number.isFinite(duration) && duration > 0 ? Math.min(end, duration) : end;
  if (limit <= start) return null;
  if (part === 'tail') return { start: Math.max(start, limit - 2), end: limit };
  return { start, end: Math.min(limit, start + (part === 'head' ? 2 : 30)) };
}
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const occupied = (file,g) => {
  const i = lowerBound(file.covered,span => span.end <= g.start);
  return Boolean(file.covered[i] && overlaps(g,file.covered[i]));
};

function lowerBound(list, skip) {
  let low = 0, high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (skip(list[middle])) low = middle+1;
    else high = middle;
  }
  return low;
}

function freeRanges(spans, start, end) {
  const ranges = [];
  let cursor = start;
  for (let i = lowerBound(spans,g => g.end <= start); i < spans.length; i++) {
    const span = spans[i];
    if (span.end <= cursor) continue;
    if (span.start >= end) break;
    if (span.start > cursor) ranges.push({start:cursor,end:span.start});
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < end) ranges.push({start:cursor,end});
  return ranges.filter(g => g.end - g.start >= .12);
}

// Build from the current saved rows. Nothing in this index is persisted.
export function createRescueSearch(blocks, sourceIds, sources) {
  const rows = blocks.filter(b => !b.deleted && script(b));
  const sourceOrder = new Map(sourceIds.map((id, index) => [id,index]));
  const files = new Map(sourceIds.map(id => [id,{duration:sources[id]?.duration || 0, assigned:[], evidence:[]}]));
  const reasons = new Map();
  for (const b of blocks) {
    if (b.deleted) continue;
    const spans = b.segments.filter(g => valid(g) && files.has(g.sourceId));
    if (!spans.length) continue;
    if (script(b) || b.sync === 'manual') {
      const duration = spans.reduce((sum,g) => sum + g.end - g.start, 0);
      const n = words(b.text).length;
      if (b.sync !== 'manual') {
        if (b.sync === 'estimated' || b.endEst) reasons.set(b.id,'境界が推定');
        else if (n >= 4 && duration < n / 7) reasons.set(b.id,'本文に対して区間が短い');
        else if (n && duration > Math.max(5, n * 1.5)) reasons.set(b.id,'本文に対して区間が長い');
      }
      spans.forEach(g => files.get(g.sourceId).assigned.push({...g,row:b}));
    } else if (b.asr && spans.length === 1 && b.text?.trim() &&
        b.sync !== 'estimated' && !b.asrBoundaryEstimated) {
      files.get(spans[0].sourceId).evidence.push({...spans[0],text:b.text,id:b.id,key:key(b.text)});
    }
    spans.forEach(g => { const file = files.get(g.sourceId); file.duration = Math.max(file.duration,g.end); });
  }
  for (const file of files.values()) {
    file.assigned.sort((a,b) => a.start - b.start || b.end - a.end);
    file.evidence.sort((a,b) => a.start - b.start);
    file.covered = [];
    let furthest;
    for (const span of file.assigned) {
      if (furthest && span.row.id !== furthest.row.id && Math.min(span.end,furthest.end) - span.start > .12) {
        for (const {row} of [span,furthest]) if (row.sync !== 'manual') reasons.set(row.id,'隣の割当と重複');
      }
      if (!furthest || span.end > furthest.end) furthest = span;
      const last = file.covered.at(-1);
      if (last && span.start <= last.end) last.end = Math.max(last.end,span.end);
      else file.covered.push({start:span.start,end:span.end});
    }
  }

  const anchor = (b, side) => {
    const spans = b.segments.filter(g => valid(g) && files.has(g.sourceId));
    if (!spans.length || (!b.aligned && b.sync !== 'manual')) return null;
    const span = side === 'before' ? spans.at(-1) : spans[0];
    return {...span,row:b,reason:reasons.get(b.id),manual:b.sync === 'manual'};
  };
  const nearby = (direction, side) => {
    const found = [];
    let trusted = null, uncertain = null, nearest = null;
    for (let i = direction > 0 ? 0 : rows.length-1; i >= 0 && i < rows.length; i += direction) {
      found[i] = {trusted,uncertain,nearest};
      const a = anchor(rows[i],side);
      if (!a) continue;
      nearest = a;
      if (a.reason) uncertain = a;
      else { trusted = a; uncertain = null; }
    }
    return found;
  };
  const left = nearby(1,'before'), right = nearby(-1,'after');
  const byRow = new Map(), runs = [];
  for (let i = 0; i < rows.length; i++) {
    if (!missing(rows[i])) continue;
    const start = i;
    while (i+1 < rows.length && missing(rows[i+1])) i++;
    const run = {rows:rows.slice(start,i+1),before:left[start],after:right[i]};
    runs.push(run);
    run.rows.forEach(b => byRow.set(b.id,run));
  }

  function search(run, expanded = false) {
    const before = run.before.trusted, after = run.after.trusted;
    const low = before ? sourceOrder.get(before.sourceId) : undefined;
    const high = after ? sourceOrder.get(after.sourceId) : undefined;
    const reversed = low !== undefined && high !== undefined &&
      (low > high || (low === high && before.end > after.start));
    const anchored = before || after;
    const candidates = [];
    const radius = Math.min(60, Math.max(20, run.rows.length * 5));
    const keys = new Set(run.rows.map(b => key(b.text)));
    if (expanded || (anchored && !reversed)) {
      for (const [sid,file] of files) {
        const rank = sourceOrder.get(sid);
        let start = low === rank ? before.end : 0;
        let end = high === rank ? after.start : file.duration;
        if (expanded && (reversed || (low !== undefined && rank < low) || (high !== undefined && rank > high))) {
          start = 0; end = file.duration;
        } else if (!expanded && ((low !== undefined && rank < low) || (high !== undefined && rank > high))) continue;
        if (!expanded && (low === undefined || high === undefined)) {
          const bound = low ?? high;
          if (Math.abs(rank - bound) > 1) continue;
          if (low !== undefined) end = Math.min(end, start + radius);
          else start = Math.max(start, end - radius);
        }
        if (end <= start) continue;
        for (const range of freeRanges(file.covered,start,end)) {
          const distance = Math.min(
            before ? Math.abs(rank-low)*radius + (rank === low ? Math.abs(range.start-before.end) : 0) : Infinity,
            after ? Math.abs(rank-high)*radius + (rank === high ? Math.abs(after.start-range.end) : 0) : Infinity);
          const inside = low !== undefined && high !== undefined && rank >= low && rank <= high && !reversed;
          if (!expanded && !inside && distance >= 2*radius) continue;
          let matchingAsr = 0;
          for (let i = lowerBound(file.evidence,g => g.start < range.start); i < file.evidence.length; i++) {
            const cue = file.evidence[i];
            if (cue.start >= range.end) break;
            if (cue.end <= range.end && keys.has(cue.key)) matchingAsr++;
          }
          candidates.push({sid,...range,matchingAsr,distance,inside,
            kind:matchingAsr ? `未割当・本文一致ASR ${matchingAsr}件` : inside ? '前後のアンカー間・未割当' : '未割当・試聴で確認'});
        }
      }
    }
    candidates.sort((a,b) => Number(b.inside)-Number(a.inside) || Number(b.matchingAsr>0)-Number(a.matchingAsr>0) ||
      a.distance-b.distance || sourceOrder.get(a.sid)-sourceOrder.get(b.sid) || a.start-b.start);
    const review = [];
    for (const edge of [run.before,run.after]) {
      for (const a of [edge.uncertain, expanded ? edge.nearest : null]) {
        if (!a || review.some(x => x.anchor.row.id === a.row.id)) continue;
        const isLeft = edge === run.before;
        review.push({sid:a.sourceId,start:isLeft ? Math.max(a.start,a.end-12) : a.start,
          end:isLeft ? a.end : Math.min(a.end,a.start+12),anchor:a,review:true,
          kind:a.reason ? `境界確認・${a.reason}` : '隣接する割当・試聴のみ'});
      }
    }
    return {candidates,review,before,after,reversed};
  }

  function estimates() {
    const result = new Map();
    for (const run of runs) {
      if (!run.before.trusted && !run.after.trusted) continue;
      const {candidates} = search(run);
      // Display-only hints. Prefer the closest free range with actual text evidence.
      const first = candidates[0];
      if (!first) continue;
      const matched = first.matchingAsr && run.rows.length <= 12 ? assignments(run.rows,first) : [];
      if (matched.length) {
        matched.forEach(({row,segment}) => result.set(row.id,{sid:first.sid,t:segment.start}));
        continue;
      }
      const evidence = files.get(first.sid).evidence;
      const text = key(run.rows[0].text);
      let cue;
      for (let i = lowerBound(evidence,g => g.start < first.start); i < evidence.length && evidence[i].start < first.end; i++) {
        if (evidence[i].end <= first.end && evidence[i].key === text) { cue = evidence[i]; break; }
      }
      const start = cue?.start ?? first.start;
      const weights = run.rows.map(b => Math.max(1,words(b.text).length));
      const total = weights.reduce((sum,n) => sum+n,0);
      let offset = 0;
      run.rows.forEach((b,i) => {
        result.set(b.id,{sid:first.sid,t:start+(Math.min(first.end-start,Math.max(5,total*.55))*offset/total)});
        offset += weights[i];
      });
    }
    return result;
  }

  function assignments(targets,{sid,start,end},local,{partial = false} = {}) {
    const file = files.get(sid);
    if (!file || !targets.length || !(end > start)) return [];
    const sourceEvidence = local || file.evidence.slice(
      lowerBound(file.evidence,g => g.start < start), lowerBound(file.evidence,g => g.start < end));
    const evidence = sourceEvidence.filter(g => g.sourceId === sid && valid(g) &&
      g.start >= start && g.end <= end && !occupied(file,g)).sort((a,b) => a.start-b.start);
    const matches = targets.map(b => {
      const text = key(b.text), options = [];
      if (!text) return options;
      for (let i = 0; i < evidence.length; i++) {
        const first = evidence[i];
        let combined = '';
        for (let j = i; j < Math.min(i+4,evidence.length); j++) {
          const last = evidence[j], prev = evidence[j-1];
          if (j > i && (last.start < prev.end || last.start-prev.end > .45)) break;
          const part = last.key ?? key(last.text);
          if (!part) break;
          combined = combined ? combined+' '+part : part;
          if (combined === text) {
            const segment = {sourceId:sid,start:first.start,end:last.end};
            if (!occupied(file,segment)) options.push({segment,evidence:evidence.slice(i,j+1)});
            break;
          }
          if (!text.startsWith(combined+' ')) break;
        }
      }
      return options;
    });
    if (partial) {
      // Rows may be missing from the recognised speech. Walk forward and backward, skipping rows
      // without a match; keep only rows whose match is the same both ways (the order fixes it).
      let c = start; const fw = matches.map(options => { const f = options.find(x => x.segment.start >= c); if (f) c = f.segment.end; return f || null; });
      c = end; const bw = []; for (let i = matches.length-1; i >= 0; i--) { const f = matches[i].findLast(x => x.segment.end <= c); bw[i] = f || null; if (f) c = f.segment.start; }
      return fw.map((x,i) => x && x === bw[i] ? {...x,row:targets[i]} : null).filter(Boolean);
    }
    // Earliest and latest valid ordered solutions must agree for every row.
    let cursor = start;
    const earliest = matches.map(options => {
      const found = options.find(x => x.segment.start >= cursor);
      if (found) cursor = found.segment.end;
      return found;
    });
    if (earliest.some(x => !x)) return [];
    cursor = end;
    for (let i = matches.length-1; i >= 0; i--) {
      const latest = matches[i].findLast(x => x.segment.end <= cursor);
      if (latest !== earliest[i]) return [];
      cursor = latest.segment.start;
    }
    return earliest.map((x,i) => ({...x,row:targets[i]}));
  }

  const isFree = segment => valid(segment) && files.has(segment.sourceId) &&
    segment.end <= files.get(segment.sourceId).duration &&
    !occupied(files.get(segment.sourceId),segment);
  const availableRanges = segment => {
    const file = files.get(segment.sourceId);
    if (!file || !valid(segment)) return [];
    return freeRanges(file.covered, segment.start, Math.min(segment.end, file.duration))
      .map(range => ({ ...segment, ...range }));
  };
  return {byRow,search,estimates,assignments,isFree,availableRanges};
}
