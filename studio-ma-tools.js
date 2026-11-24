// 1.19.19: small pure helpers for MA-type assignment work (tested in tests/ma-tools.mjs). No storage, no media.

// rows of symbols only (─, ───) are separators: never matched, counted or rescued. “Wait—” has words, so it stays.
export const hasWords = (text) => /[\p{L}\p{N}]/u.test(text || '');
export const isSymbolRow = (b) => !!b && !!(b.text || '').trim() && !hasWords(b.text);
// still to do: no sound / not matched yet (and not manual), or a bulk estimate not confirmed yet
export const needsWork = (b) => !isSymbolRow(b) && Boolean(b.unconfirmed || (!b.aligned && b.sync !== 'manual'));
export const wordCount = (t) => (String(t || '').match(/[\p{L}\p{N}']+/gu) || []).length;

// Lines that are the ONLY unassigned line between two lines with sound. freeOf(seg, rowId) returns the unused
// ranges inside seg (other assigned lines excluded). Neighbours are never moved.
export function planBulkGaps(ids, byId, freeOf) {
  const order = ids.filter((id) => byId[id] && !isSymbolRow(byId[id]));
  const missing = (b) => b && !b.segments?.length && (b.text || '').trim() && b.sync !== 'manual';
  const can = [], skip = [];
  for (let i = 0; i < order.length; i++) {
    const b = byId[order[i]]; if (!missing(b)) continue;
    const P = byId[order[i - 1]], N = byId[order[i + 1]], why = (r) => skip.push({ b, r });
    if (missing(P) || missing(N)) { why('未割当が連続'); continue; }
    if (!P?.segments?.length || !N?.segments?.length) { why('前後のどちらかに音声がない'); continue; }
    const L = P.segments.at(-1), R = N.segments[0];
    if (L.sourceId !== R.sourceId) { why('前後が別の音声ファイル'); continue; }
    if (R.start <= L.end + .05) { why(R.start < L.end - .05 ? '前後の区間が重なっている' : '前後の間に音声がない'); continue; }
    const n = Math.max(1, wordCount(b.text)), d = R.start - L.end;
    if (d < Math.max(.4, n * .12)) { why(`間が短すぎる（${d.toFixed(1)}秒）`); continue; }
    if (d > Math.max(8, n * 1.6)) { why(`間が長すぎる（${d.toFixed(1)}秒）`); continue; }
    const seg = { sourceId: L.sourceId, start: L.end, end: R.start };
    const free = freeOf(seg, b.id);
    if (free.length !== 1 || free[0].start - L.end > .1 || R.start - free[0].end > .1) { why('間にほかの行の区間がある'); continue; }
    can.push({ b, seg });
  }
  return { can, skip };
}

// a long range in overlapping pieces; a cue is kept only in the middle part of its piece (counted once across a seam)
export function rangePieces(start, end, size = 18, overlap = 2) {
  const out = [];
  for (let a = start; a < end - .05; a += size - overlap) { const z = Math.min(end, a + size); out.push([a, z]); if (z >= end) break; }
  return out;
}
export function keepInPiece(cue, k, pieces, overlap = 2) {
  const [a, z] = pieces[k], lo = k === 0 ? -Infinity : a + overlap / 2, hi = k === pieces.length - 1 ? Infinity : z - overlap / 2;
  const mid = (cue.start + cue.end) / 2;
  return mid >= lo && mid < hi;
}

// remove the parts given to other lines from a line's segments (pieces shorter than 0.15 s are dropped)
export function withoutTaken(segments, taken) {
  return segments.flatMap((g) => taken.reduce((ps, t) => ps.flatMap((p) => p.sourceId !== t.sourceId || p.end <= t.start || p.start >= t.end ? [p]
    : [{ ...p, end: t.start }, { ...p, start: t.end }].filter((q) => q.end - q.start >= .15)), [g]));
}

// the line directly before / after (symbol rows skipped). Returns null when that line has no sound:
// a line further away (past an unassigned line) is never treated as the neighbour.
export function adjacentWithSound(order, byId, id, dir) {
  const k = order.indexOf(id);
  for (let i = k + dir; i >= 0 && i < order.length; i += dir) {
    const x = byId[order[i]];
    if (!x || isSymbolRow(x)) continue;
    return x.segments?.length ? x : null;
  }
  return null;
}
