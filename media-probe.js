// Reads the table of contents of MP4 / MOV files (no full read), lists sound tracks, takes one sound track out
// and repacks it as a small single-track .m4a that Safari can decode exactly. Pure browser code, no network.

const R32 = (d, o) => d.getUint32(o), R16 = (d, o) => d.getUint16(o);
const typeAt = (d, o) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));

// top-level boxes: read 16-byte headers only
async function topBoxes(blob) {
  const out = []; let off = 0;
  while (off + 8 <= blob.size && out.length < 64) {
    const d = new DataView(await blob.slice(off, off + 16).arrayBuffer());
    let size = R32(d, 0); const type = typeAt(d, 4); let hdr = 8;
    if (size === 1) { size = Number(d.getBigUint64(8)); hdr = 16; } else if (size === 0) size = blob.size - off;
    if (size < 8) break;
    out.push({ type, off, size, hdr }); off += size;
  }
  return out;
}
function children(d, start, end) {
  const out = []; let o = start;
  while (o + 8 <= end) {
    let size = R32(d, o); const type = typeAt(d, o + 4); let hdr = 8;
    if (size === 1) { size = Number(d.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
    if (size < 8 || o + size > end) break;
    out.push({ type, o, size, body: o + hdr, end: o + size }); o += size;
  }
  return out;
}
const find = (d, box, ...path) => { let cur = box; for (const t of path) { cur = children(d, cur.body, cur.end).find((c) => c.type === t); if (!cur) return null; } return cur; };
const LANG = (v) => { const l = v >= 0x400 ? String.fromCharCode(((v >> 10) & 31) + 96, ((v >> 5) & 31) + 96, (v & 31) + 96) : ''; return /^[a-z]{3}$/.test(l) ? l : 'und'; };

function parseEsds(d, b) {   // returns AudioSpecificConfig bytes
  let o = b.body + 4; const end = b.end;
  const len = () => { let n = 0; for (let i = 0; i < 4; i++) { const x = d.getUint8(o++); n = (n << 7) | (x & 127); if (!(x & 128)) break; } return n; };
  while (o < end) {
    const tag = d.getUint8(o++); const l = len();
    if (tag === 3) { o += 2; const f = d.getUint8(o++); if (f & 128) o += 2; if (f & 64) o += d.getUint8(o) + 1; if (f & 32) o += 2; continue; }
    if (tag === 4) { o += 13; continue; }
    if (tag === 5) return new Uint8Array(d.buffer, d.byteOffset + o, l).slice();
    o += l;
  }
  return null;
}

// → { tracks: [{ id, kind: 'audio'|'video'|..., codec, lang, name, timescale, duration, channels, rate, asc, samples: { off[], size[], dur[] } }], container }
function audioPresentation(d, list, movieScale, trackScale) {
  if (!list) return { offset: 0, start: 0, end: Infinity };
  if (list.body + 8 > list.end) return null;
  const version = d.getUint8(list.body), count = R32(d, list.body + 4);
  if (!movieScale || !trackScale || version > 1 || count < 1 || count > 2) return null;
  const stride = version === 1 ? 20 : 12;
  if (list.body + 8 + count * stride > list.end) return null;
  let start = 0;
  for (let i = 0; i < count; i++) {
    const at = list.body + 8 + i * stride;
    const length = version === 1 ? Number(d.getBigUint64(at)) : R32(d, at);
    const pos = version === 1 ? Number(d.getBigInt64(at + 8)) : d.getInt32(at + 4);
    if (d.getUint32(at + stride - 4) !== 0x10000) return null;
    if (pos === -1 && i === 0 && count === 2) { start = length / movieScale; continue; }
    if (pos < 0 || i !== count - 1) return null;
    return { offset: start - pos / trackScale, start, end: start + length / movieScale };
  }
  return null;
}

export async function probe(blob) {
  const tops = await topBoxes(blob);
  const ftyp = tops.find((b) => b.type === 'ftyp');
  const moovBox = tops.find((b) => b.type === 'moov');
  if (!moovBox) throw new Error(tops.length ? 'ファイルの目次（moov）が見つかりません（mp4 / mov ではないか、途中で切れたファイル）' : 'mp4 / mov 形式ではありません');
  if (moovBox.size > 200 * 1024 * 1024) throw new Error('目次が大きすぎます');
  const buf = await blob.slice(moovBox.off, moovBox.off + moovBox.size).arrayBuffer();
  const d = new DataView(buf); const moov = { body: moovBox.hdr, end: moovBox.size };
  const mvhd = find(d, moov, 'mvhd');
  const scaleOffset = mvhd && mvhd.body + (d.getUint8(mvhd.body) === 1 ? 20 : 12);
  const movieScale = scaleOffset && scaleOffset + 4 <= mvhd.end ? R32(d, scaleOffset) : 0;
  const tracks = [];
  for (const trak of children(d, moov.body, moov.end).filter((c) => c.type === 'trak')) {
    const tkhd = find(d, trak, 'tkhd'), mdhd = find(d, trak, 'mdia', 'mdhd'), hdlr = find(d, trak, 'mdia', 'hdlr'), stbl = find(d, trak, 'mdia', 'minf', 'stbl');
    if (!tkhd || !mdhd || !hdlr || !stbl) continue;
    const v = d.getUint8(tkhd.body), id = R32(d, tkhd.body + (v === 1 ? 20 : 12));
    const mv = d.getUint8(mdhd.body);
    const timescale = R32(d, mdhd.body + (mv === 1 ? 20 : 12));
    const duration = mv === 1 ? Number(d.getBigUint64(mdhd.body + 24)) : R32(d, mdhd.body + 16);
    const lang = LANG(R16(d, mdhd.body + (mv === 1 ? 32 : 20)));
    const handler = typeAt(d, hdlr.body + 8);
    let name = ''; for (let o = hdlr.body + 24; o < hdlr.end; o++) { const c = d.getUint8(o); if (!c) break; name += String.fromCharCode(c); }
    const kind = handler === 'soun' ? 'audio' : handler === 'vide' ? 'video' : handler;
    const t = { id, kind, handler, lang, name: name.trim(), timescale, duration: duration / timescale, codec: '', channels: 0, rate: 0, asc: null, enabled: !!(d.getUint32(tkhd.body) & 1) };
    if (kind === 'audio') t.presentation = audioPresentation(d, find(d, trak, 'edts', 'elst'), movieScale, timescale);
    const stsd = find(d, stbl, 'stsd');
    if (stsd) {
      const e = children(d, stsd.body + 8, stsd.end)[0];
      if (e) {
        t.codec = e.type;
        if (kind === 'audio') {
          const ver = R16(d, e.body + 8);   // QuickTime sound description version
          t.channels = R16(d, e.body + 16); t.bits = R16(d, e.body + 18); t.rate = R32(d, e.body + 24) / 65536;
          const ext = ver === 1 ? 16 : ver === 2 ? 36 : 0;
          if (ver === 2) { t.rate = d.getFloat64(e.body + 32); t.channels = R32(d, e.body + 40); }
          const inner = children(d, e.body + 28 + ext, e.end);
          const wave = inner.find((c) => c.type === 'wave');
          const esds = inner.find((c) => c.type === 'esds') || (wave && children(d, wave.body, wave.end).find((c) => c.type === 'esds'));
          if (esds) t.asc = parseEsds(d, esds);
        }
      }
    }
    if (kind === 'audio') {   // sample table
      const box = (n) => find(d, stbl, n);
      const stsz = box('stsz'), stco = box('stco') || box('co64'), stsc = box('stsc'), stts = box('stts');
      if (stsz && stco && stsc && stts) {
        const fixed = R32(d, stsz.body + 4), n = R32(d, stsz.body + 8);
        const size = new Uint32Array(n); for (let i = 0; i < n; i++) size[i] = fixed || R32(d, stsz.body + 12 + i * 4);
        const nc = R32(d, stco.body + 4), co = new Float64Array(nc);
        for (let i = 0; i < nc; i++) co[i] = stco.type === 'co64' ? Number(d.getBigUint64(stco.body + 8 + i * 8)) : R32(d, stco.body + 8 + i * 4);
        const ns = R32(d, stsc.body + 4), sc = []; for (let i = 0; i < ns; i++) sc.push([R32(d, stsc.body + 8 + i * 12), R32(d, stsc.body + 12 + i * 12)]);
        const off = new Float64Array(n); let k = 0;
        for (let c = 0; c < nc && k < n; c++) {
          let per = sc[0][1]; for (const [first, spc] of sc) { if (c + 1 >= first) per = spc; else break; }
          let o = co[c]; for (let j = 0; j < per && k < n; j++, k++) { off[k] = o; o += size[k]; }
        }
        const dur = new Uint32Array(n); let m = 0; const ne = R32(d, stts.body + 4);
        for (let i = 0; i < ne && m < n; i++) { const cnt = R32(d, stts.body + 8 + i * 8), dl = R32(d, stts.body + 12 + i * 8); for (let j = 0; j < cnt && m < n; j++) dur[m++] = dl; }
        t.samples = { off, size, dur, n };
      }
    }
    tracks.push(t);
  }
  return { container: ftyp ? typeAt(new DataView(await blob.slice(ftyp.off + 8, ftyp.off + 12).arrayBuffer()), 0).trim() : '', tracks };
}

export const audioTracks = (info) => info.tracks.filter((t) => t.kind === 'audio');
export const canExtract = (t) => !!t.samples && ((t.codec === 'mp4a' && t.asc) || ['sowt', 'twos', 'lpcm', 'ipcm'].includes(t.codec));

// read the samples of one track between t0 and t1 seconds (whole track if omitted), reading the file in pieces
export async function extractTrack(blob, t, t0 = 0, t1 = Infinity) {
  if (!canExtract(t)) throw new Error(`この音声の形式（${t.codec || '不明'}）は取り出せません`);
  const { off, size, dur, n } = t.samples;
  let i0 = 0, acc = 0; while (i0 < n && (acc + dur[i0]) / t.timescale <= t0) acc += dur[i0++];
  const start = acc / t.timescale; let i1 = i0;
  while (i1 < n && acc / t.timescale < t1) acc += dur[i1++];
  const frames = []; let i = i0;
  while (i < i1) {   // contiguous samples are read in one go
    let j = i, end = off[i] + size[i];
    while (j + 1 < i1 && off[j + 1] === end && end - off[i] < 4 * 1024 * 1024) { j++; end += size[j]; }
    const bytes = new Uint8Array(await blob.slice(off[i], end).arrayBuffer());
    for (let k = i, p = 0; k <= j; k++) { frames.push(bytes.subarray(p, p + size[k])); p += size[k]; }
    i = j + 1;
  }
  if (t.codec === 'mp4a') return { blob: mp4Audio(frames, t.asc, Math.round(t.rate) || t.timescale, t.channels || 1, dur.subarray(i0, i1)), start, codec: 'm4a' };
  return { blob: pcmWav(frames, t), start, codec: 'wav' };
}
// Translate the player's timeline into source-sample time for boundary inspection.
export async function extractPresentationRange(blob, track, start, end) {
  const map = track.presentation;
  if (!map) throw new Error('複雑な音声編集リストのため、再生位置を特定できません');
  const from = Math.max(start, map.start), to = Math.min(end, map.end);
  if (to <= from) throw new Error('指定位置に音声トラックがありません');
  const clip = await extractTrack(blob, track, from - map.offset, to - map.offset);
  return { ...clip, start: clip.start + map.offset, from, to };
}

function pcmWav(frames, t) {
  const total = frames.reduce((a, f) => a + f.length, 0), ch = t.channels || 1, bits = t.bits || 16, rate = Math.round(t.rate) || t.timescale;
  const h = new DataView(new ArrayBuffer(44)); const w = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); h.setUint32(4, 36 + total, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, (rate * ch * bits) / 8, true); h.setUint16(32, (ch * bits) / 8, true); h.setUint16(34, bits, true); w(36, 'data'); h.setUint32(40, total, true);
  let parts = frames;
  if (t.codec === 'twos' && bits === 16) parts = frames.map((f) => { const c = f.slice(); for (let i = 0; i + 1 < c.length; i += 2) { const x = c[i]; c[i] = c[i + 1]; c[i + 1] = x; } return c; });   // big → little endian
  return new Blob([h.buffer, ...parts], { type: 'audio/wav' });
}

// minimal .m4a (MP4) for AAC frames: the index lets iPhone seek exactly
export function mp4Audio(frames, asc, rate = 16000, channels = 1, durs = null) {
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], u16 = (n) => [(n >> 8) & 255, n & 255];
  const str = (t) => [...t].map((c) => c.charCodeAt(0));
  const box = (type, ...parts) => { const body = []; for (const p of parts) for (const x of p) body.push(x); return [...u32(body.length + 8), ...str(type), ...body]; };
  const full = (type, v, f, ...parts) => box(type, [v, ...u32(f).slice(1)], ...parts);
  const n = frames.length;
  // sample durations: run-length encoded (usually all 1024)
  const runs = []; for (let i = 0; i < n; i++) { const dl = durs ? durs[i] : 1024; if (runs.length && runs[runs.length - 1][1] === dl) runs[runs.length - 1][0]++; else runs.push([1, dl]); }
  const dur = runs.reduce((a, [c, dl]) => a + c * dl, 0);
  const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);
  const desc = (tag, body) => [tag, body.length, ...body];
  const esds = full('esds', 0, 0, desc(3, [...u16(1), 0, ...desc(4, [0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...desc(5, [...asc])]), ...desc(6, [2])]));
  const mp4a = box('mp4a', [0, 0, 0, 0, 0, 0, ...u16(1), 0, 0, 0, 0, 0, 0, 0, 0, ...u16(channels), ...u16(16), 0, 0, 0, 0, ...u32(Math.min(65535, rate) * 65536)], esds);
  const sizes = []; for (const f of frames) sizes.push(...u32(f.length));
  const moov = (off) => box('moov',
    full('mvhd', 0, 0, [...u32(0), ...u32(0), ...u32(rate), ...u32(dur), ...u32(0x00010000), ...u16(0x0100), ...Array(10).fill(0), ...matrix, ...Array(24).fill(0), ...u32(2)]),
    box('trak',
      full('tkhd', 0, 3, [...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(dur), ...Array(8).fill(0), ...u16(0), ...u16(0), ...u16(0x0100), 0, 0, ...matrix, ...u32(0), ...u32(0)]),
      box('mdia',
        full('mdhd', 0, 0, [...u32(0), ...u32(0), ...u32(rate), ...u32(dur), ...u16(0x55c4), 0, 0]),
        full('hdlr', 0, 0, [...u32(0), ...str('soun'), ...Array(12).fill(0), ...str('SoundHandler'), 0]),
        box('minf',
          full('smhd', 0, 0, [0, 0, 0, 0]),
          box('dinf', full('dref', 0, 0, [...u32(1)], full('url ', 0, 1, []))),
          box('stbl',
            full('stsd', 0, 0, [...u32(1)], mp4a),
            full('stts', 0, 0, [...u32(runs.length), ...runs.flatMap(([c, dl]) => [...u32(c), ...u32(dl)])]),
            full('stsc', 0, 0, [...u32(1), ...u32(1), ...u32(n), ...u32(1)]),
            full('stsz', 0, 0, [...u32(0), ...u32(n)], sizes),
            full('stco', 0, 0, [...u32(1), ...u32(off)]))))));
  const ftyp = box('ftyp', str('M4A '), u32(0), str('M4A '), str('isom'), str('mp42'));
  const off = ftyp.length + moov(0).length + 8;
  const mdatLen = frames.reduce((a, f) => a + f.length, 0) + 8;
  return new Blob([new Uint8Array(ftyp), new Uint8Array(moov(off)), new Uint8Array([...u32(mdatLen), ...str('mdat')]), ...frames], { type: 'audio/mp4' });
}

// how much speech a 16 kHz signal contains: share of 20 ms frames clearly above the noise floor, and loudness
export function speechStats(audio) {
  const F = 320, rms = [];
  for (let i = 0; i + F <= audio.length; i += F) { let x = 0; for (let k = 0; k < F; k++) x += audio[i + k] * audio[i + k]; rms.push(Math.sqrt(x / F)); }
  if (!rms.length) return { speech: 0, level: 0, peak: 0 };
  const s = rms.slice().sort((a, b) => a - b), floor = s[Math.floor(s.length * 0.1)], top = s[Math.floor(s.length * 0.95)];
  const th = Math.max(floor * 4, top * 0.1, 0.003);
  const active = rms.filter((v) => v > th).length / rms.length;
  const level = rms.reduce((a, b) => a + b, 0) / rms.length;
  // speech varies (syllables): ratio of frame-to-frame changes; steady noise/music changes less
  let ch = 0; for (let i = 1; i < rms.length; i++) ch += Math.abs(rms[i] - rms[i - 1]); const vary = ch / rms.length / (level || 1);
  return { speech: active, level, peak: top, vary };
}

// decide which sound track to use. decode(blob) → { audio } (16 kHz). Returns { chosen, auto, reason, stats[] }
export async function chooseTrack(blob, info, decode) {
  const at = audioTracks(info);
  if (!at.length) return { chosen: null, auto: true, reason: '音声トラックがありません', stats: [] };
  if (at.length === 1) return { chosen: at[0], auto: true, reason: '音声トラックは1本です', stats: [] };
  const stats = [];
  for (const t of at) {
    if (!canExtract(t)) { stats.push({ t, ok: false, why: `形式 ${t.codec}` }); continue; }
    const D = t.duration || 60; let sp = 0, lv = 0, vr = 0, k = 0;
    for (const p of [0.2, 0.5, 0.8]) {
      const a = Math.max(0, D * p - 4);
      try { const x = await extractTrack(blob, t, a, a + 8); const { audio } = await decode(x.blob); const s = speechStats(audio); sp += s.speech; lv += s.level; vr += s.vary || 0; k++; } catch {}
    }
    stats.push(k ? { t, ok: true, speech: sp / k, level: lv / k, vary: vr / k } : { t, ok: false, why: '展開できない' });
  }
  const ok = stats.filter((s) => s.ok).sort((a, b) => b.speech * b.level - a.speech * a.level);
  if (!ok.length) return { chosen: null, auto: false, reason: 'どの音声トラックも取り出せませんでした', stats };
  if (ok.length === 1) return { chosen: ok[0].t, auto: true, reason: 'ほかのトラックは取り出せない形式', stats };
  const [a, b] = ok;
  const en = ok.filter((s) => s.t.lang === 'eng'); if (en.length === 1 && ok.some((s) => s.t.lang !== 'eng' && s.t.lang !== 'und')) return { chosen: en[0].t, auto: true, reason: '英語のトラック', stats };
  if (b.speech < 0.05 || b.level < 0.002) return { chosen: a.t, auto: true, reason: 'ほかのトラックはほぼ無音', stats };
  if (a.level >= b.level * 4 && a.speech >= b.speech) return { chosen: a.t, auto: true, reason: '音量がほかの4倍以上', stats };
  return { chosen: a.t, auto: false, reason: '複数のトラックに音声があります', stats };
}

// A copy of an mp4/mov that keeps only ONE sound track (the speech track), without re-encoding anything:
// the old table of contents (moov) is renamed to 'free' (so every data offset stays valid) and a new moov
// without the other sound tracks is added at the end. Read into memory in pieces → saved as plain bytes.
export async function keepOneAudioTrack(blob, keepTrackId, { name = 'video.mp4', type = blob.type || 'video/mp4', onProgress = () => {} } = {}) {
  const tops = await topBoxes(blob);
  const mb = tops.find((b) => b.type === 'moov');
  if (!mb || mb.hdr !== 8) throw new Error('この動画の目次を書き換えられません');
  const moov = new Uint8Array(await blob.slice(mb.off, mb.off + mb.size).arrayBuffer());
  const d = new DataView(moov.buffer);
  const kids = children(d, 8, mb.size);
  const drop = new Set();
  for (const k of kids) {
    if (k.type !== 'trak') continue;
    const hd = find(d, k, 'mdia', 'hdlr'), th = find(d, k, 'tkhd'); if (!hd || !th) continue;
    const v = d.getUint8(th.body), id = d.getUint32(th.body + (v === 1 ? 20 : 12));
    if (typeAt(d, hd.body + 8) === 'soun' && id !== keepTrackId) drop.add(k);
  }
  if (!drop.size) return null;
  const keep = kids.filter((k) => !drop.has(k));
  const len = 8 + keep.reduce((a, k) => a + k.size, 0);
  const nm = new Uint8Array(len); const nd = new DataView(nm.buffer);
  nd.setUint32(0, len); nm.set([109, 111, 111, 118], 4);   // 'moov'
  let o = 8; for (const k of keep) { nm.set(moov.subarray(k.o, k.o + k.size), o); o += k.size; }
  // copy the file in 8 MB pieces, renaming the old moov header to 'free'
  const parts = [], N = 8 * 1024 * 1024;
  for (let p = 0; p < blob.size; p += N) {
    const buf = new Uint8Array(await blob.slice(p, Math.min(blob.size, p + N)).arrayBuffer());
    const at = mb.off + 4 - p;   // position of the 4 type bytes inside this piece
    for (let i = 0; i < 4; i++) if (at + i >= 0 && at + i < buf.length) buf[at + i] = [102, 114, 101, 101][i];   // 'free'
    parts.push(buf.buffer); onProgress(Math.min(1, (p + N) / blob.size));
  }
  parts.push(nm.buffer);
  return new File(parts, name, { type });
}
