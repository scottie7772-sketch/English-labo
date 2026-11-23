// Script ↔ audio alignment.
// The recognised text (with mistakes) only tells WHERE each word is in time; the shown text comes from the script.
// 1) normalise words of both, 2) find where the recognised words sit in the script (3-word anchors),
// 3) align piece by piece with a tolerant word alignment (dynamic programming),
// 4) matched script words take the recognised times, the others are interpolated, 5) lines get start/end.

const norm = (w) => w.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
// words with their character positions (hyphenated names count as one word: Qui-Gon → quigon)
export function words(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/[A-Za-z0-9][A-Za-z0-9'’‘`-]*/g)) { const w = norm(m[0]); if (w) out.push({ w, cs: m.index, ce: m.index + m[0].length }); }
  return out;
}
function near(a, b) {
  if (a === b) return 2;
  if (a.length < 4 || b.length < 4) return 0;
  if (Math.abs(a.length - b.length) > 2) return 0;
  // edit distance ≤ 1 (or ≤ 2 for long words)
  const lim = a.length >= 7 ? 2 : 1; let i = 0, j = 0, e = 0;
  const d = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; let rowMin = d[0]; for (j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; rowMin = Math.min(rowMin, d[j]); } if (rowMin > lim) return 0; }
  e = d[b.length];
  return e <= lim ? 1 : 0;
}
const MATCH = 3, NEAR = 1, MIS = -2, GAP = -1;
// semi-global: all of r is aligned, s may be skipped freely at both ends. returns [[ri, si, kind], ...]
function dp(r, s) {
  const R = r.length, S = s.length, W = S + 1;
  const H = new Float32Array((R + 1) * W), T = new Uint8Array((R + 1) * W);   // 1 diag, 2 up (skip r), 3 left (skip s)
  for (let i = 1; i <= R; i++) { H[i * W] = i * GAP; T[i * W] = 2; }
  for (let i = 1; i <= R; i++) for (let j = 1; j <= S; j++) {
    const k = near(r[i - 1], s[j - 1]);
    const d = H[(i - 1) * W + j - 1] + (k === 2 ? MATCH : k === 1 ? NEAR : MIS), u = H[(i - 1) * W + j] + GAP, l = H[i * W + j - 1] + GAP;
    let v = d, t = 1; if (u > v) { v = u; t = 2; } if (l > v) { v = l; t = 3; }
    H[i * W + j] = v; T[i * W + j] = t;
  }
  let j = 0, best = -Infinity; for (let x = 0; x <= S; x++) if (H[R * W + x] > best) { best = H[R * W + x]; j = x; }
  const pairs = []; let i = R;
  while (i > 0 && j > 0) {
    const t = T[i * W + j];
    if (t === 1) { const k = near(r[i - 1], s[j - 1]); if (k) pairs.push([i - 1, j - 1, k]); i--; j--; }
    else if (t === 2) i--; else j--;
  }
  return pairs.reverse();
}
// where in s does r (or a part of it) most likely sit? (votes of 3-word anchors on the same diagonal)
function anchor(r, s, index) {
  const votes = new Map();
  for (let j = 0; j + 2 < r.length; j++) {
    const hits = index.get(r[j] + ' ' + r[j + 1] + ' ' + r[j + 2]); if (!hits || hits.length > 30) continue;
    for (const i of hits) { const d = Math.round((i - j) / 8); votes.set(d, (votes.get(d) || 0) + 1); }
  }
  let bd = null, bv = 0; for (const [d, v] of votes) { const v2 = v + (votes.get(d - 1) || 0) + (votes.get(d + 1) || 0); if (v2 > bv) { bv = v2; bd = d; } }
  return bv >= 2 ? { offset: bd * 8, votes: bv } : null;
}

// scriptLines: [{ id, text }] in order; cues: [{ id, start, end, text }] of ONE audio file, in time order
// → { times: Map(lineId → { start, end }), covered: Set(cueId), matched, total, firstLine, lastLine }
export function alignScript(scriptLines, cues, { chunk = 250 } = {}) {
  const S = []; scriptLines.forEach((l, li) => words(l.text).forEach((w, k) => S.push({ ...w, li, k })));
  const R = [];
  for (const c of cues) {
    const ws = words(c.text), len = Math.max(1, String(c.text).length), d = Math.max(0.05, c.end - c.start);
    ws.forEach((w) => R.push({ w: w.w, t0: c.start + (d * w.cs) / len, t1: c.start + (d * w.ce) / len, cue: c.id }));
  }
  const res = { times: new Map(), covered: new Set(), matched: 0, total: R.length, lines: 0 };
  if (!S.length || !R.length) return res;
  const sw = S.map((x) => x.w), rw = R.map((x) => x.w);
  const index = new Map(); for (let i = 0; i + 2 < sw.length; i++) { const k = sw[i] + ' ' + sw[i + 1] + ' ' + sw[i + 2]; if (!index.has(k)) index.set(k, []); index.get(k).push(i); }
  const sTime = new Array(S.length).fill(null);   // matched script word → recognised word index
  let pos = null;
  for (let a = 0; a < R.length; a += chunk) {
    const b = Math.min(R.length, a + chunk), part = rw.slice(a, b);
    const tryAt = (from) => {
      const lo = Math.max(0, from - 40), hi = Math.min(S.length, from + Math.ceil(part.length * 1.6) + 60);
      const pr = dp(part, sw.slice(lo, hi)).map(([ri, si, k]) => [ri + a, si + lo, k]);
      return { pr, ratio: pr.filter((p) => p[2] === 2).length / part.length };
    };
    let got = pos != null ? tryAt(pos) : null;
    if (!got || got.ratio < 0.35) { const an = anchor(part, sw, index); if (an) { const g2 = tryAt(Math.max(0, an.offset)); if (!got || g2.ratio > got.ratio) got = g2; } }
    if (!got || got.ratio < 0.25) continue;   // this part of the audio is not in the script
    for (const [ri, si] of got.pr) if (sTime[si] == null) sTime[si] = ri;
    pos = Math.max(pos ?? 0, got.pr.at(-1)[1] + 1);
  }
  // recognised cues mostly matched → covered (replaced by the script lines)
  const used = new Set(sTime.filter((x) => x != null));
  const per = new Map(); R.forEach((x, i) => { const p = per.get(x.cue) || [0, 0]; p[1]++; if (used.has(i)) p[0]++; per.set(x.cue, p); });
  for (const [id, [m, n]] of per) if (m / n >= 0.5) res.covered.add(id);
  res.matched = used.size;
  // times for every script word between matched ones (interpolated by character position inside the gap)
  const idx = sTime.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return res;
  const T0 = new Array(S.length).fill(null), T1 = new Array(S.length).fill(null);
  for (const i of idx) { T0[i] = R[sTime[i]].t0; T1[i] = R[sTime[i]].t1; }
  for (let q = 0; q + 1 < idx.length; q++) {
    const p = idx[q], n = idx[q + 1]; if (n - p < 2) continue;
    const gapT = T0[n] - T1[p]; if (gapT > 2 + (n - p) * 1.2) continue;   // too long: probably audio that skips the script here
    for (let i = p + 1; i < n; i++) { const f0 = (i - p - 0.5) / (n - p), f1 = (i - p + 0.5) / (n - p); T0[i] = T1[p] + gapT * f0; T1[i] = T1[p] + gapT * f1; }
  }
  // words of a partly matched line before the first / after the last matched word: extend at ~2.6 words per second
  const byLine = new Map(); S.forEach((x, i) => { if (!byLine.has(x.li)) byLine.set(x.li, []); byLine.get(x.li).push(i); });
  for (const [, ws] of byLine) {
    const timed = ws.filter((i) => T0[i] != null); if (!timed.length) continue;
    const f = timed[0], l = timed.at(-1);
    // never reach outside the recognised line that holds the first / last matched word (other speech may be there)
    const cf = sTime[f] != null ? cues.find((c) => c.id === R[sTime[f]].cue) : null, cl = sTime[l] != null ? cues.find((c) => c.id === R[sTime[l]].cue) : null;
    for (const i of ws) {
      if (i < f) { T0[i] = Math.max(cf ? cf.start : -Infinity, T0[f] - (f - i) * 0.38); T1[i] = T0[i] + 0.3; }
      if (i > l) { T1[i] = Math.min(cl ? cl.end : Infinity, T1[l] + (i - l) * 0.38); T0[i] = T1[i] - 0.3; }
    }
  }
  const first = cues[0].start, last = cues.at(-1).end;
  const lines = [];
  for (const [li, ws] of byLine) {
    const nMatched = ws.filter((i) => sTime[i] != null).length, timed = ws.filter((i) => T0[i] != null);
    if (!timed.length) continue;
    const interior = timed.length === ws.length;   // every word got a time (matched or between matched words)
    if (!interior && nMatched / ws.length < 0.3) continue;
    if (!nMatched && ws.length > 3) continue;
    // A vocabulary headword must not be aligned to its occurrence INSIDE an example sentence.
    // If no standalone recognised cue exists, leave it unmatched rather than inventing a time.
    if (ws.length === 1) {
      const ri = sTime[ws[0]];
      if (ri == null) continue;
      const cue = cues.find((c) => c.id === R[ri].cue);
      if (!cue || words(cue.text).length !== 1) continue;
    }
    lines.push({ li, start: Math.max(first, Math.min(...timed.map((i) => T0[i]))), end: Math.min(last, Math.max(...timed.map((i) => T1[i]))) });
  }
  lines.sort((x, y) => x.li - y.li);
  // keep lines in order without overlap, with a little breathing room
  for (let k = 0; k < lines.length; k++) {
    const L = lines[k], P = lines[k - 1], N = lines[k + 1];
    L.start = Math.max(P ? P.end : first, L.start - 0.15);
    L.end = Math.min(N ? Math.max(L.end, (L.end + N.start) / 2) : last, L.end + 0.25);
    if (N && L.end > N.start) { const m = (L.end + N.start) / 2; L.end = m; N.start = Math.max(N.start, m); }
    if (L.end - L.start < 0.3) L.end = L.start + 0.3;
  }
  for (const L of lines) res.times.set(scriptLines[L.li].id, { start: +L.start.toFixed(2), end: +L.end.toFixed(2) });
  res.lines = lines.length;
  return res;
}

// split plain script text into lines for subtitles: keep the user's line breaks, cut long paragraphs into sentences
export function scriptToLines(text) {
  const out = [];
  for (const para of String(text || '').replace(/\r/g, '').split(/\n+/)) {
    const p = para.trim(); if (!p) continue;
    const sents = (p.match(/[^.!?]+[.!?]+["”’)\]]*\s*|[^.!?]+$/g) || [p]).map((x) => x.trim()).filter(Boolean);
    let cur = '';
    for (const s of sents) { cur = cur ? cur + ' ' + s : s; if (cur.length >= 12) { out.push(cur); cur = ''; } }   // very short pieces ("Yes.") join the next sentence
    if (cur) { if (out.length && cur.length < 12 && sents.length > 1) out[out.length - 1] += ' ' + cur; else out.push(cur); }
  }
  return out;
}

// Check actual same-source coverage so repeated readings retain their own intervals.
export function hasReplacementAudio(segment, replacements) {
  const overlaps = replacements
    .filter(s => s.sourceId === segment.sourceId && s.start < segment.end && s.end > segment.start)
    .sort((a, b) => a.start - b.start);
  let cursor = segment.start, covered = 0;
  for (const span of overlaps) {
    const end = Math.min(segment.end, span.end);
    covered += Math.max(0, end - Math.max(cursor, span.start));
    cursor = Math.max(cursor, end);
  }
  // Small timestamp discrepancies are expected between ASR and alignment.
  const length = segment.end - segment.start;
  return length > 0 && length - covered <= Math.min(.08, length * .1);
}
