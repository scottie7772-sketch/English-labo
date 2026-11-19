// Studio editing operations. Pure functions: take block states, return new block states (+ new order).
// Audio (segments), English, Japanese, holes and cue references always move together inside one block.
import { newBlock, tokensOf, blockDur } from './studio-db.js';
import { newId } from './common-idb.js';

const rev = (b) => `${b.id}@${b.rev}`;
const SENT_EN = /(?<=[.!?…]["”’)]?)\s+/;
const SENT_JA = /(?<=[。！？!?])/;

// virtual time (inside the block) -> position in a segment
export function locate(b, v) {
  let acc = 0;
  for (let i = 0; i < b.segments.length; i++) {
    const s = b.segments[i], d = s.end - s.start;
    if (v <= acc + d + 1e-6) return { i, t: s.start + Math.max(0, v - acc) };
    acc += d;
  }
  const last = b.segments.length - 1; return { i: last, t: b.segments[last]?.end ?? 0 };
}
// split the segment list at virtual time v
function cutSegments(b, v) {
  const { i, t } = locate(b, v);
  const left = b.segments.slice(0, i).map((s) => ({ ...s })), right = b.segments.slice(i + 1).map((s) => ({ ...s }));
  const s = b.segments[i];
  if (s) { if (t - s.start > 0.02) left.push({ ...s, end: t }); if (s.end - t > 0.02) right.unshift({ ...s, start: t }); }
  return [left, right];
}
// time map: align = [{ s, e, v0, v1 }] = tokens s..e are spoken between virtual times v0..v1
export function alignOf(b) {
  const n = tokensOf(b.text).length;
  return b.align?.length ? b.align : n ? [{ s: 0, e: n - 1, v0: 0, v1: blockDur(b) }] : [];
}
// virtual time at a token boundary: exact at a known range edge, otherwise proportional inside the range (by characters)
export function estimateTime(b, k) {
  const toks = tokensOf(b.text);
  for (const r of alignOf(b)) {
    if (k === r.s) return r.v0;
    if (k > r.s && k <= r.e) {
      const part = toks.slice(r.s, r.e + 1); const total = part.join(' ').length || 1;
      const before = part.slice(0, k - r.s).join(' ').length + 1;
      return r.v0 + (r.v1 - r.v0) * (before / total);
    }
    if (k === r.e + 1) return r.v1;
  }
  const total = toks.join(' ').length || 1, before = toks.slice(0, k).join(' ').length + (k ? 1 : 0);
  return blockDur(b) * (before / total);
}
// is token boundary k exactly known (edge of an align range)?
export const exactAt = (b, k) => alignOf(b).some((r) => r.s === k || r.e + 1 === k) && !!b.align?.length;
function splitAlign(b, k, v) {
  const left = [], right = [];
  for (const r of alignOf(b)) {
    if (r.e < k) left.push({ ...r });
    else if (r.s >= k) right.push({ s: r.s - k, e: r.e - k, v0: Math.max(0, r.v0 - v), v1: Math.max(0, r.v1 - v) });
    else { left.push({ s: r.s, e: k - 1, v0: r.v0, v1: v }); right.push({ s: 0, e: r.e - k, v0: 0, v1: Math.max(0, r.v1 - v) }); }
  }
  return [left, right];
}
const sliceHoles = (holes, from, to) => (holes || []).filter((h) => h.s >= from && h.e < to).map((h) => ({ ...h, s: h.s - from, e: h.e - from }));

// ---------- split at a token boundary (k = index of first token of the second part) ----------
export function splitAt(b, k, v = null, jaParts = null) {
  const toks = tokensOf(b.text);
  if (k <= 0 || k >= toks.length) throw new Error('英文の途中を選んでください');
  const vt = v ?? estimateTime(b, k);
  const [segA, segB] = cutSegments(b, vt);
  if (!segA.length || !segB.length) throw new Error('この位置では音声を分けられません');
  const lin = { op: 'split', from: [rev(b)], at: Date.now() };
  const ja = jaParts || splitJa(b.ja, 2);
  if (!jaParts && !/[.?!]["')\]]?$/.test(toks[k - 1] || '')) ja.ok = !b.ja;   // cut inside a sentence: the translation cannot be split reliably
  const [alA, alB] = splitAlign(b, k, vt);
  const known = v != null || exactAt(b, k);
  const common = { setId: b.setId, cueRefs: structuredClone(b.cueRefs), sync: known ? (b.sync === 'estimated' ? 'estimated' : 'manual') : 'estimated', lineage: lin };
  const A = newBlock(b.setId, { ...common, align: alA, segments: segA, text: toks.slice(0, k).join(' '), holes: sliceHoles(b.holes, 0, k), ja: ja[0], jaStatus: ja.ok ? 'ok' : b.ja ? 'needsReview' : 'ok' });
  const B = newBlock(b.setId, { ...common, align: alB, segments: segB, text: toks.slice(k).join(' '), holes: sliceHoles(b.holes, k, toks.length), ja: ja[1], jaStatus: ja.ok ? 'ok' : b.ja ? 'needsReview' : 'ok' });
  return [A, B];
}
function splitJa(ja, n) {
  const parts = String(ja || '').split(SENT_JA).map((x) => x.trim()).filter(Boolean);
  if (parts.length === n) { const r = parts; r.ok = true; return r; }
  const r = [ja || '', ...Array(n - 1).fill('')]; r.ok = !ja; return r;
}
// ---------- split into sentences (each selected block) ----------
export function splitSentences(b) {
  const sents = String(b.text).split(SENT_EN).filter(Boolean);
  if (sents.length < 2) return null;
  const jaP = splitJa(b.ja, sents.length);
  const bounds = []; let acc = 0;
  for (let i = 0; i < sents.length - 1; i++) { acc += tokensOf(sents[i]).length; bounds.push(acc); }
  const pieces = []; let work = { ...b, ja: '' };
  for (let i = bounds.length - 1; i >= 0; i--) {   // cut from the end so token indexes stay valid
    const [A, B] = splitAt(work, bounds[i]);
    pieces.unshift(B); work = { ...A, id: b.id, rev: b.rev };
  }
  pieces.unshift(work);
  const lin = { op: 'split', from: [rev(b)], at: Date.now() };
  return pieces.map((p, i) => ({ ...p, id: newId('b_'), rev: 0, deleted: false, lineage: lin, ja: jaP[i] || '', jaStatus: jaP.ok ? 'ok' : b.ja ? 'needsReview' : 'ok', sync: 'estimated' }));
}

// ---------- merge (ordered list; may be far apart or from different files) ----------
export function merge(list) {
  if (list.length < 2) throw new Error('2つ以上選んでください');
  let holes = [], align = [], off = 0, voff = 0;
  for (const b of list) {
    holes = holes.concat((b.holes || []).map((h) => ({ ...h, s: h.s + off, e: h.e + off })));
    align = align.concat(alignOf(b).map((r) => ({ s: r.s + off, e: r.e + off, v0: r.v0 + voff, v1: r.v1 + voff })));
    off += tokensOf(b.text).length; voff += blockDur(b);
  }
  const jaSep = list.some((b) => /[a-z]/i.test(b.ja || '')) ? ' ' : '';
  return newBlock(list[0].setId, {
    segments: list.flatMap((b) => b.segments.map((s) => ({ ...s }))),
    text: list.map((b) => b.text).filter(Boolean).join(' '),
    ja: list.map((b) => b.ja).filter(Boolean).join(jaSep),
    jaStatus: list.some((b) => b.jaStatus === 'needsReview') ? 'needsReview' : 'ok',
    holes, align, cueRefs: { en: list.flatMap((b) => b.cueRefs?.en || []), ja: list.flatMap((b) => b.cueRefs?.ja || []) },
    sync: list.some((b) => b.sync === 'estimated') ? 'estimated' : list.some((b) => b.sync === 'manual') ? 'manual' : 'auto',
    lineage: { op: 'merge', from: list.map(rev), at: Date.now() },
  });
}
export function duplicate(b) {
  return newBlock(b.setId, { ...structuredClone(b), id: undefined, rev: 0, lineage: { op: 'duplicate', from: [rev(b)], at: Date.now() } });
}
export function shiftTime(b, d) {
  return { ...b, segments: b.segments.map((s) => ({ ...s, start: Math.max(0, +(s.start + d).toFixed(3)), end: Math.max(0.05, +(s.end + d).toFixed(3)) })), sync: 'manual' };
}
export function setEdge(b, edge, t) {
  const segs = b.segments.map((s) => ({ ...s }));
  if (edge === 'start') segs[0].start = +t.toFixed(3); else segs[segs.length - 1].end = +t.toFixed(3);
  const nb = { ...b, segments: segs, sync: 'manual' };
  const k = blockDur(b) ? blockDur(nb) / blockDur(b) : 1;   // keep the time map in proportion
  if (b.align?.length) nb.align = b.align.map((r) => ({ ...r, v0: r.v0 * k, v1: r.v1 * k }));
  return nb;
}
// text edit keeps holes on unchanged words (word-level LCS)
export function editText(b, text, ja) {
  const a = tokensOf(b.text), n = tokensOf(text);
  const map = lcsMap(a, n);
  const holes = (b.holes || []).map((h) => ({ ...h, ns: map[h.s], ne: map[h.e] }))
    .filter((h) => h.ns != null && h.ne != null && h.ne - h.ns === h.e - h.s).map(({ ns, ne, ...h }) => ({ ...h, s: ns, e: ne }));
  const align = n.length === a.length ? b.align : [];   // word count changed: times inside the block are no longer known
  return { ...b, text, ja, holes, align, jaStatus: ja ? 'ok' : b.jaStatus };
}
function lcsMap(a, b) {
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = norm(a[i]) === norm(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const m = {}; let i = 0, j = 0;
  while (i < a.length && j < b.length) { if (norm(a[i]) === norm(b[j])) { m[i] = j; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return m;
}
// hole toggle (adjacent tokens join into one hole)
export function toggleHole(b, i) {
  const toks = tokensOf(b.text);
  const holes = (b.holes || []).map((h) => ({ ...h }));
  const text = (s, e) => toks.slice(s, e + 1).join(' ').replace(/[.,!?;:"“”]+$/, '');
  const at = holes.findIndex((h) => i >= h.s && i <= h.e);
  if (at >= 0) {
    const h = holes.splice(at, 1)[0];
    if (h.s < i) holes.push({ s: h.s, e: i - 1, text: text(h.s, i - 1) });
    if (i < h.e) holes.push({ s: i + 1, e: h.e, text: text(i + 1, h.e) });
  } else {
    let s = i, e = i;
    const L = holes.findIndex((h) => h.e === i - 1), R = holes.findIndex((h) => h.s === i + 1);
    if (L >= 0) s = holes[L].s; if (R >= 0) e = holes[R].e;
    for (const k of [L, R].filter((x) => x >= 0).sort((x, y) => y - x)) holes.splice(k, 1);
    holes.push({ s, e, text: text(s, e) });
  }
  return { ...b, holes: holes.sort((x, y) => x.s - y.s) };
}
// selection helpers
export function orderedSelection(order, sel) { return order.filter((id) => sel.has(id)); }
export function ranges(order, sel) {
  const out = []; let cur = null;
  order.forEach((id, i) => { if (sel.has(id)) { if (cur && cur.end === i - 1) cur.end = i; else out.push(cur = { start: i, end: i }); } });
  return out;
}
// move ordered ids before target id (or to end when target null), keeping their relative order
export function moveIds(order, ids, targetId) {
  const set = new Set(ids);
  const rest = order.filter((id) => !set.has(id));
  let at = targetId ? rest.indexOf(targetId) : rest.length; if (at < 0) at = rest.length;
  return [...rest.slice(0, at), ...ids, ...rest.slice(at)];
}
export function moveStep(order, ids, dir) {
  const o = order.slice(); const set = new Set(ids);
  if (dir < 0) { for (let i = 1; i < o.length; i++) if (set.has(o[i]) && !set.has(o[i - 1])) [o[i - 1], o[i]] = [o[i], o[i - 1]]; }
  else { for (let i = o.length - 2; i >= 0; i--) if (set.has(o[i]) && !set.has(o[i + 1])) [o[i + 1], o[i]] = [o[i], o[i + 1]]; }
  return o;
}
