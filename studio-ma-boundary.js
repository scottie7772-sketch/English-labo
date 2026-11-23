import { words } from './studio-align.js';
import { maScriptRow } from './studio-ma-audit.js';
import { speechRegions } from './studio-structure.js';

const round = value => Math.round(value * 1000) / 1000;
const segment = row => row?.segments?.[0];
const valid = row => row?.segments?.length === 1 && segment(row).end > segment(row).start;
const locked = row => row?.sync === 'manual';

export function maSeams(blocks) {
  const rows = blocks.filter(maScriptRow);
  const seams = [];
  for (let i = 0; i <= rows.length; i++) {
    const left = rows[i - 1], right = rows[i];
    if ((left && !valid(left)) || (right && !valid(right))) continue;
    if (left && right && segment(left).sourceId !== segment(right).sourceId) continue;
    const editable = [left, right].some(row => row && !locked(row));
    if (editable) seams.push({ left, right, sourceId: segment(left || right).sourceId });
  }
  return seams;
}

export function maWindow(seam, duration, margin) {
  const a = segment(seam.left)?.end, b = segment(seam.right)?.start;
  const first = a ?? b, last = b ?? a;
  if (Math.abs(first - last) > 2) return null;
  return { start: Math.max(0, Math.min(first, last) - margin), end: Math.min(duration, Math.max(first, last) + margin) };
}

export function inspectMaSeam(seam, audio, offset = 0) {
  const a = segment(seam.left)?.end, b = segment(seam.right)?.start;
  if (a != null && b != null && a - b > .045) return '隣接文との重複';
  if (a != null && b != null && b - a > .42) return '字幕間の空白';
  const regions = speechRegions(audio).map(g => ({ start: g.start + offset, end: g.end + offset }));
  // A continuous utterance spanning a close seam is normal. Look for a nearby
  // acoustic edge, supported by an energy contrast, before asking for ASR.
  const energy = (at, width) => {
    const first = Math.max(0, Math.round((at - offset) * 16000));
    const last = Math.min(audio.length, first + Math.round(width * 16000));
    let sum = 0;
    for (let i = first; i < last; i++) sum += audio[i] ** 2;
    return last > first ? Math.sqrt(sum / (last - first)) : 0;
  };
  for (const [at, beginning] of [[a, false], [b, true]]) {
    if (at == null || (beginning ? locked(seam.right) : locked(seam.left))) continue;
    const crossed = regions.some(g => g.start + .075 < at && at < g.end - .075 &&
      Math.abs((beginning ? g.start : g.end) - at) < .65);
    const edge = regions.some(g => {
      const bound = beginning ? g.start : g.end;
      return Math.abs(bound - at) > .19 && Math.abs(bound - at) < .65 &&
        energy(bound + (beginning ? .05 : -.13), .08) > 2 * energy(bound + (beginning ? -.15 : .06), .08) + .002;
    });
    if ((crossed || edge) && (!seam.left || !seam.right || !regions.some(g =>
      g.start < Math.min(a, b) - .55 && g.end > Math.max(a, b) + .55))) {
      return beginning ? '語頭の切れ・前の文の混入候補' : '語尾の切れ・次の文の混入候補';
    }
  }
  return '';
}

function scriptEdge(row, heard, side) {
  const script = words(row.text).map(w => w.w);
  // Match a unique ordered script phrase directly to model word timestamps.
  // Short lines must match completely; long lines need at least three words.
  for (let n = Math.min(5, script.length); n >= Math.min(3, script.length) && n > 0; n--) {
    const phrase = side === 'end' ? script.slice(-n) : script.slice(0, n);
    const hits = [];
    for (let i = 0; i + n <= heard.length; i++) {
      if (phrase.every((word, j) => word === heard[i + j].word &&
        (!j || (heard[i+j].start >= heard[i+j-1].end - .025 && heard[i+j].start - heard[i+j-1].end <= .55)))) hits.push(i);
    }
    if (hits.length !== 1) continue;
    const first = heard[hits[0]], last = heard[hits[0] + n - 1];
    return { time: side === 'end' ? last.end : first.start, first: first.start, last: last.end, n };
  }
  return null;
}

export function proposeMaSeam(seam, chunks, duration, window = null) {
  const heard = chunks.flatMap(cue => {
    const ts = words(cue.text);
    return ts.length === 1 && Number.isFinite(cue.start) && cue.start >= 0 &&
      cue.end > cue.start && cue.end <= duration + .04 && cue.end - cue.start <= 1.8 ?
      [{ word: ts[0].w, start: cue.start, end: cue.end }] : [];
  });
  const tail = seam.left && scriptEdge(seam.left, heard, 'end');
  const head = seam.right && scriptEdge(seam.right, heard, 'start');
  const hold = reason => ({ changes: [], confidence: 'review', reason });
  if ((seam.left && !tail) || (seam.right && !head)) return hold('正解スクリプトの境界語を特定できません');
  if (window && [tail, head].filter(Boolean).some(anchor =>
    (window.start > .02 && anchor.first < window.start + .08) ||
    (window.end < duration - .02 && anchor.last > window.end - .08))) {
    return hold('再認識した区間の端に境界語があり、切れている可能性があります');
  }
  if (tail && head && (tail.time > head.time + .025 || head.time - tail.time > 1.5)) return hold('前後の英文の時刻が矛盾しています');
  const split = tail && head ? (tail.time + head.time) / 2 : null;
  const changes = [];
  const add = (row, side, anchor, bound) => {
    if (!row || locked(row)) return true;
    const g = segment(row);
    // Padding is bounded by the neighbouring words and vanishes at a continuous seam.
    const time = round(side === 'end' ? Math.min(duration, bound, anchor.time + .055) : Math.max(0, bound, anchor.time - .065));
    if (Math.abs(time - g[side]) > 1.1 || (side === 'end' ? time - g.start : g.end - time) < .18) return false;
    if (Math.abs(time - g[side]) >= .065) changes.push({ row, side, time });
    return true;
  };
  const leftBound = locked(seam.right) ? Math.min(split, segment(seam.right).start) : split ?? duration;
  const rightBound = locked(seam.left) ? Math.max(split, segment(seam.left).end) : split ?? 0;
  if ((tail && leftBound < tail.time - .025) || (head && rightBound > head.time + .025)) return hold('手動区間または隣接文と競合します');
  if (!add(seam.left, 'end', tail, leftBound) || !add(seam.right, 'start', head, rightBound)) return hold('移動量または修正後の長さを確認してください');
  return { changes, confidence: tail && head && tail.n >= 3 && head.n >= 3 ? 'high' : 'medium' };
}

export function maBoundaryUpdates(blocks, proposals) {
  const updates = new Map();
  for (const { changes } of proposals) for (const { row, side, time } of changes) {
    if (locked(row)) continue;
    const current = updates.get(row.id) || segment(row);
    updates.set(row.id, { ...current, [side]: time });
  }
  for (const [id, g] of updates) {
    if (g.end - g.start < .18 || g.start < 0) return null;
    // Other scripted/hand-edited segments may lie outside the paired seams.
    // Only allow edits that do not introduce a new overlap.
    const prior = segment(blocks.find(row => row.id === id));
    for (const row of blocks) {
      if (row.id === id || !maScriptRow(row)) continue;
      for (const other of row.segments || []) {
        if (other.sourceId !== g.sourceId) continue;
        const replaced = updates.get(row.id) || other;
        const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
        if (overlap(g, replaced) > overlap(prior, other) + .002) return null;
      }
    }
  }
  return blocks.filter(row => updates.has(row.id)).map(row => {
    const g = updates.get(row.id), old = segment(row), duration = g.end - g.start;
    const remap = t => Math.max(0, Math.min(duration, round(t + old.start - g.start)));
    const align = (row.align || []).map(a => ({ ...a, v0: remap(a.v0), v1: remap(a.v1) })).filter(a => a.v1 > a.v0);
    return { ...row, segments: [g], align };
  });
}

// Standard RIFF PCM/float WAV. Only read headers and the requested sample frames.
export async function wavRangeReader(blob) {
  const header = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (header.byteLength < 12 || header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57415645) return null;
  let format, start, bytes;
  for (let at = 12, count = 0; at + 8 <= blob.size && count < 128; count++) {
    const chunk = new DataView(await blob.slice(at, at + 8).arrayBuffer());
    const tag = chunk.getUint32(0), size = chunk.getUint32(4, true);
    if (tag === 0x666d7420 && size >= 16 && size <= 1024) format = await blob.slice(at + 8, at + 8 + size).arrayBuffer();
    if (tag === 0x64617461) { start = at + 8; bytes = Math.min(size, blob.size - start); break; }
    at += 8 + size + size % 2;
  }
  if (!format || !bytes) return null;
  const fmt = new DataView(format), codec = fmt.getUint16(0, true);
  const rate = fmt.getUint32(4, true), frame = fmt.getUint16(12, true);
  if (![1, 3].includes(codec) || !rate || !frame) return null;
  const frames = Math.floor(bytes / frame);
  return (a, b) => {
    const first = Math.max(0, Math.floor(a * rate)), last = Math.min(frames, Math.ceil(b * rate));
    if (last <= first) throw new Error('指定範囲に音声がありません');
    const payload = (last - first) * frame;
    const out = new DataView(new ArrayBuffer(28 + format.byteLength + format.byteLength % 2));
    const label = (at, text) => [...text].forEach((letter, i) => out.setUint8(at + i, letter.charCodeAt(0)));
    label(0, 'RIFF'); label(8, 'WAVE'); label(12, 'fmt ');
    out.setUint32(4, out.byteLength + payload + payload % 2 - 8, true);
    out.setUint32(16, format.byteLength, true);
    new Uint8Array(out.buffer, 20, format.byteLength).set(new Uint8Array(format));
    label(out.byteLength - 8, 'data');
    out.setUint32(out.byteLength - 4, payload, true);
    return { blob: new Blob([out.buffer, blob.slice(start + first * frame, start + last * frame), new Uint8Array(payload % 2)], { type: 'audio/wav' }), start: first / rate };
  };
}
