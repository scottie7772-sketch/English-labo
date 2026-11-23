// Audio compression (1.16): any stored sound → AAC-LC mono .m4a at a chosen bitrate, on the device, free.
// The file is read and decoded in pieces (MP3 / AAC-in-MP4 / WAV by frames), so long recordings do not fill the memory;
// encoding runs in a Worker (WebCodecs AudioEncoder: iPhone Safari 26+). Nothing is sent anywhere.
import { probe, audioTracks } from './media-probe.js';

export const TIERS = {
  light:  { label: '軽度', kbps: 64, rate: 32000, note: '音質ほぼそのまま' },
  std:    { label: '標準', kbps: 48, rate: 32000, note: '会話・朗読に十分' },
  strong: { label: '強め', kbps: 32, rate: 24000, note: '子音（s・f・th）はやや弱く' },
};
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
const CHUNK_SEC = 60, LEAD = 10;   // frames decoded before and after each piece (decoder warm-up, MP3 bit reservoir), then cut away

export const bytesPerMin = (tier) => Math.round((TIERS[tier].kbps * 1000 / 8) * 60 * 1.02);
// expected size after compression, and whether it is worth doing
export function estimate(size, duration, tier) {
  const after = Math.round((TIERS[tier].kbps * 1000 / 8) * duration * 1.02 + 4096);
  const kbpsNow = duration ? Math.round((size * 8) / duration / 1000) : 0;
  return { after, saved: Math.max(0, size - after), ratio: size ? Math.max(0, 1 - after / size) : 0, worth: after < size * 0.9, kbpsNow };
}

let supportCache = null;
export async function canCompress() {
  if (supportCache) return supportCache;
  const out = {};
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return (supportCache = { ok: false, why: 'この端末のブラウザは音声の変換に対応していません（iPhoneはiOS 26以降のSafariで使えます）' });
  for (const [k, t] of Object.entries(TIERS)) {
    try { out[k] = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: t.rate, numberOfChannels: 1, bitrate: t.kbps * 1000 })).supported; } catch { out[k] = false; }
  }
  const ok = Object.values(out).some(Boolean);
  return (supportCache = { ok, tiers: out, why: ok ? '' : 'この端末ではAACに変換できません' });
}

// ---------------- reading the source in frames ----------------
const MP3_BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Header(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = (b[i + 2] >> 4) & 15, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;   // Layer III only
  const br = MP3_BR[ver === 3 ? 1 : 2][bri] * 1000, sr = MP3_SR[ver][sri];
  const len = ver === 3 ? Math.floor((144 * br) / sr) + pad : Math.floor((72 * br) / sr) + pad;
  return { len, sr, spf: ver === 3 ? 1152 : 576 };
}
async function mp3Index(blob) {
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  let pos = 0;
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) pos = 10 + ((head[6] & 127) << 21 | (head[7] & 127) << 14 | (head[8] & 127) << 7 | (head[9] & 127)) + (head[5] & 16 ? 10 : 0);
  const off = [], len = []; let sr = 0, spf = 0;
  const N = 4 * 1024 * 1024;
  let p = pos, wS = 0, w = new Uint8Array(0);
  const load = async (at) => { wS = at; w = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + N)).arrayBuffer()); };
  await load(p);
  while (p + 4 <= blob.size) {
    if (p + 8 > wS + w.length && wS + w.length < blob.size) await load(p);
    const i = p - wS, h = mp3Header(w, i);
    if (!h || (sr && h.sr !== sr)) { p++; continue; }
    if (!sr && p + h.len + 4 <= blob.size) {   // before locking on, the next frame must follow
      if (i + h.len + 4 > w.length) { await load(p); continue; }
      if (!mp3Header(w, i + h.len)) { p++; continue; }
    }
    if (!sr) { sr = h.sr; spf = h.spf; }
    off.push(p); len.push(Math.min(h.len, blob.size - p)); p += h.len;
  }
  if (!off.length) throw new Error('MP3のフレームが見つかりません');
  // a Xing/Info header frame is not sound: leave it out (players skip it too)
  const f0 = new Uint8Array(await blob.slice(off[0], off[0] + Math.min(len[0], 200)).arrayBuffer());
  const s = String.fromCharCode(...f0);
  let delay = 0, pad = 0, gapless = false;
  const xi = Math.max(s.indexOf('Xing'), s.indexOf('Info'));
  if (xi >= 0) {
    // gapless info (LAME tag): players hide the encoder delay + decoder delay (529) at the start and the padding at the end
    const fl = (f0[xi + 4] << 24) | (f0[xi + 5] << 16) | (f0[xi + 6] << 8) | f0[xi + 7];
    let q = xi + 8 + (fl & 1 ? 4 : 0) + (fl & 2 ? 4 : 0) + (fl & 4 ? 100 : 0) + (fl & 8 ? 4 : 0);
    if (q + 24 <= f0.length && /^(LAME|Lavc|Lavf|GOGO)/.test(s.slice(q, q + 4))) {
      delay = (f0[q + 21] << 4) | (f0[q + 22] >> 4); pad = ((f0[q + 22] & 15) << 8) | f0[q + 23]; gapless = true;
    }
    off.shift(); len.shift();
  }
  return { kind: 'mp3', off, len, sr, spf, skip: gapless ? delay + 529 : 0, total: gapless ? off.length * spf - delay - pad : 0 };
}
async function aacIndex(blob, trackIndex = null) {
  const info = await probe(blob);
  const tr = audioTracks(info);
  const t = (trackIndex != null ? tr.find((x) => x.index === trackIndex) : null) || tr.find((x) => x.codec === 'mp4a' && x.samples && x.asc);
  if (!t || t.codec !== 'mp4a' || !t.samples || !t.asc) return null;
  const ot = t.asc[0] >> 3, fi = ((t.asc[0] & 7) << 1) | (t.asc[1] >> 7), ch = (t.asc[1] >> 3) & 15;
  if (fi === 15 || ot > 4 || !ch) return null;   // HE-AAC or unusual: decode the whole file instead
  const { off, size, n } = t.samples;
  // priming removed by the original file's edit list (so our timeline matches what the player showed)
  let skip = 0;
  try {
    for (const [a, b] of [[0, Math.min(blob.size, 4 << 20)], [Math.max(0, blob.size - (4 << 20)), blob.size]]) {
      const u = new Uint8Array(await blob.slice(a, b).arrayBuffer());
      for (let i = 0; i + 24 < u.length; i++) if (u[i] === 0x65 && u[i + 1] === 0x6c && u[i + 2] === 0x73 && u[i + 3] === 0x74) {
        const v = u[i + 4], dv = new DataView(u.buffer, u.byteOffset + i + 8);
        const mt = v === 1 ? Number(dv.getBigInt64(4 + 8)) : dv.getInt32(4 + 4);
        if (mt > 0 && mt < 10000) { skip = mt; break; }
      }
      if (skip) break;
    }
  } catch {}
  return { kind: 'aac', off: Array.from(off.subarray ? off.subarray(0, n) : off.slice(0, n)), len: Array.from(size.subarray ? size.subarray(0, n) : size.slice(0, n)), sr: RATES[fi], spf: 1024, adts: [ot, fi, ch], skip };
}
async function wavIndex(blob) {
  const h = new DataView(await blob.slice(0, Math.min(blob.size, 4096)).arrayBuffer());
  const tag = (o) => String.fromCharCode(h.getUint8(o), h.getUint8(o + 1), h.getUint8(o + 2), h.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let p = 12, fmt = null, data = null;
  while (p + 8 <= h.byteLength) {
    const id = tag(p), sz = h.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { ch: h.getUint16(p + 10, true), sr: h.getUint32(p + 12, true), align: h.getUint16(p + 20, true), bits: h.getUint16(p + 22, true), code: h.getUint16(p + 8, true) };
    if (id === 'data') { data = { off: p + 8, size: Math.min(sz, blob.size - p - 8) }; break; }
    p += 8 + sz + (sz & 1);
  }
  if (!fmt || !data || !fmt.align) return null;
  return { kind: 'wav', fmt, data, sr: fmt.sr };
}
const adtsHead = ([ot, fi, ch], n) => { const L = n + 7; return new Uint8Array([0xff, 0xf1, ((ot - 1) << 6) | (fi << 2) | (ch >> 2), ((ch & 3) << 6) | (L >> 11), (L >> 3) & 0xff, ((L & 7) << 5) | 0x1f, 0xfc]); };
function wavHead(fmt, bytes) {
  const v = new DataView(new ArrayBuffer(44)); const w = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, fmt.code === 0xfffe ? (fmt.bits === 32 ? 3 : 1) : fmt.code, true); v.setUint16(22, fmt.ch, true);
  v.setUint32(24, fmt.sr, true); v.setUint32(28, fmt.sr * fmt.align, true); v.setUint16(32, fmt.align, true); v.setUint16(34, fmt.bits, true); w(36, 'data'); v.setUint32(40, bytes, true);
  return v.buffer;
}

// ---------------- decoding one piece ----------------
async function decodeBytes(ac, ab) {
  return new Promise((res, rej) => { const no = (e) => rej(e instanceof Error ? e : new Error('音声を読み込めませんでした')); const p = ac.decodeAudioData(ab, res, no); if (p?.then) p.then(res, no); });
}
// decoded buffer → mono Float32 at the target rate (OfflineAudioContext does the mixing and the resampling)
async function toMono(buf, rate) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const n = Math.max(1, Math.ceil(buf.duration * rate));
  const off = new OAC(1, n, rate); const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
  return (await off.startRendering()).getChannelData(0);
}

// how many samples the new piece is off: compare its warm-up part with the end of the previous piece (0 if unclear)
function lineUp(mono, lead, tail, rate) {
  const T = tail.length, max = Math.round(0.03 * rate);
  let e0 = 0; for (let i = 0; i < T; i++) e0 += tail[i] * tail[i];
  if (e0 < T * 1e-6 || lead - T - max < 0 || lead + max > mono.length) return 0;
  let best = 0, bestC = -1;
  for (let d = -max; d <= max; d++) {
    const o = lead - T + d; let c = 0, e1 = 0;
    for (let i = 0; i < T; i++) { const v = mono[o + i]; c += v * tail[i]; e1 += v * v; }
    const nc = e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
    if (nc > bestC) { bestC = nc; best = d; }
  }
  return bestC > 0.9 ? best : 0;
}

// ---------------- the encoder worker (inline, no extra file) ----------------
const WORKER = `
let enc, frames = [], err = null, inSamples = 0, firstTs = null, rate = 0;
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'init') {
      rate = m.rate;
      enc = new AudioEncoder({ output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); if (firstTs === null) firstTs = c.timestamp;
        frames.push(b.length > 7 && b[0] === 0xff && (b[1] & 0xf0) === 0xf0 ? b.slice((b[1] & 1) ? 7 : 9) : b); }, error: (x) => (err = x) });
      enc.configure({ codec: m.codec || 'mp4a.40.2', sampleRate: m.rate, numberOfChannels: 1, bitrate: m.kbps * 1000 });
      postMessage({ cmd: 'ready' });
    } else if (m.cmd === 'pcm') {
      const d = m.data, step = rate;   // 1 s per AudioData
      for (let i = 0; i < d.length; i += step) {
        const part = d.subarray(i, Math.min(d.length, i + step));
        const ad = new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((inSamples / rate) * 1e6), data: part });
        enc.encode(ad); ad.close(); inSamples += part.length;
        while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
      }
      if (err) throw err;
      postMessage({ cmd: 'ready' });
    } else if (m.cmd === 'end') {
      await enc.flush(); enc.close();
      if (err) throw err;
      postMessage({ cmd: 'done', frames, inSamples, firstTs }, frames.map((f) => f.buffer));
      frames = [];
    }
  } catch (x) { postMessage({ cmd: 'error', message: String(x && x.message || x) }); }
};`;
function startWorker(rate, kbps, codec) {
  const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
  const w = new Worker(url); URL.revokeObjectURL(url);
  let waiting = null;
  w.onmessage = (e) => { const r = waiting; waiting = null; if (!r) return; e.data.cmd === 'error' ? r.rej(new Error('変換に失敗しました: ' + e.data.message)) : r.res(e.data); };
  w.onerror = (e) => { const r = waiting; waiting = null; r?.rej(new Error('変換に失敗しました: ' + (e.message || 'worker'))); };
  const call = (msg, transfer) => new Promise((res, rej) => { waiting = { res, rej }; w.postMessage(msg, transfer || []); });
  return { init: () => call({ cmd: 'init', rate, kbps, codec }), pcm: (d) => call({ cmd: 'pcm', data: d }, [d.buffer]), end: () => call({ cmd: 'end' }), stop: () => w.terminate() };
}

// ---------------- .m4a with an edit list (removes the encoder's priming so the timing stays exact) ----------------
function ascFor(rate) { const fi = RATES.indexOf(rate); return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (1 << 3)]); }
function m4a(frames, rate, contentSamples, priming) {
  const enc = new TextEncoder();
  const cat = (arrs) => { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]), u16 = (n) => new Uint8Array([(n >> 8) & 255, n & 255]);
  const box = (type, ...parts) => { const body = cat(parts); return cat([u32(body.length + 8), enc.encode(type), body]); };
  const full = (type, v, f, ...parts) => box(type, new Uint8Array([v, (f >> 16) & 255, (f >> 8) & 255, f & 255]), ...parts);
  const z = (n) => new Uint8Array(n);
  const n = frames.length, mediaDur = n * 1024;
  const matrix = cat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));
  const desc = (tag, body) => cat([new Uint8Array([tag, body.length]), body]);
  const asc = ascFor(rate);
  const esds = full('esds', 0, 0, desc(3, cat([u16(1), z(1), desc(4, cat([new Uint8Array([0x40, 0x15, 0, 0, 0]), u32(0), u32(0), desc(5, asc)])), desc(6, new Uint8Array([2]))])));
  const mp4a = box('mp4a', z(6), u16(1), z(8), u16(1), u16(16), z(4), u32(Math.min(65535, rate) * 65536), esds);
  const sizes = new Uint8Array(n * 4); const sv = new DataView(sizes.buffer); frames.forEach((f, i) => sv.setUint32(i * 4, f.length));
  const elst = box('edts', full('elst', 0, 0, u32(1), u32(contentSamples), u32(priming), u32(0x00010000)));
  const moov = (off) => box('moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(rate), u32(contentSamples), u32(0x00010000), u16(0x0100), z(10), matrix, z(24), u32(2)),
    box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(contentSamples), z(8), u16(0), u16(0), u16(0x0100), z(2), matrix, u32(0), u32(0)),
      elst,
      box('mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(rate), u32(mediaDur), u16(0x55c4), z(2)),
        full('hdlr', 0, 0, u32(0), enc.encode('soun'), z(12), enc.encode('SoundHandler'), z(1)),
        box('minf', full('smhd', 0, 0, z(4)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
          box('stbl', full('stsd', 0, 0, u32(1), mp4a), full('stts', 0, 0, u32(1), u32(n), u32(1024)),
            full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)), full('stsz', 0, 0, u32(0), u32(n), sizes), full('stco', 0, 0, u32(1), u32(off)))))));
  const ftyp = box('ftyp', enc.encode('M4A '), u32(0), enc.encode('M4A isommp42'));
  const off = ftyp.length + moov(0).length + 8;
  const mdatLen = frames.reduce((a, f) => a + f.length, 0) + 8;
  return new Blob([ftyp, moov(off), cat([u32(mdatLen), enc.encode('mdat')]), ...frames], { type: 'audio/mp4' });
}

// does it open and have the right length?
export function checkPlayable(blob, expect) {
  return new Promise((res) => {
    const a = new Audio(); const url = URL.createObjectURL(blob); let done = false;
    const fin = (ok, d) => { if (done) return; done = true; URL.revokeObjectURL(url); a.removeAttribute('src'); a.load(); res({ ok, duration: d }); };
    a.preload = 'metadata'; a.onloadedmetadata = () => fin(Number.isFinite(a.duration) && (!expect || Math.abs(a.duration - expect) < Math.max(0.25, expect * 0.002)), a.duration);
    a.onerror = () => fin(false, 0); setTimeout(() => fin(false, 0), 15000); a.src = url;
  });
}

// ---------------- main entry ----------------
// blob → { file (m4a), duration, bytes }. Throws on failure; the caller keeps the original.
export async function compressAudio(blob, { tier = 'std', name = 'audio', duration = 0, trackIndex = null, onProgress = () => {}, isCancelled = () => false } = {}) {
  const T = TIERS[tier]; if (!T) throw new Error('圧縮の強さが不明です');
  const test = globalThis.__compressTest;   // automated tests only (desktop browsers without AAC): other codec + a copy of the PCM
  const sup = test ? { ok: true, tiers: { [tier]: true } } : await canCompress(); if (!sup.ok || !sup.tiers[tier]) throw new Error(sup.why || 'この強さには対応していません');
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const isMp4 = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;   // 'ftyp'
  let src = null;
  onProgress(0, '音声を調べています…');
  try {
    if (isMp4) src = await aacIndex(blob, trackIndex);
    else if (head[0] === 0x52 && head[1] === 0x49) src = await wavIndex(blob);
    else src = await mp3Index(blob).catch(() => null);
  } catch { src = null; }
  const AC = window.AudioContext || window.webkitAudioContext; const ac = new AC();
  const W = startWorker(T.rate, T.kbps, test?.codec); await W.init();
  let produced = 0;
  const feed = async (f32) => { if (isCancelled()) throw new Error('中止しました'); produced += f32.length; test?.tap?.(f32.slice()); await W.pcm(f32); };
  try {
    if (src && (src.kind === 'mp3' || src.kind === 'aac')) {
      const per = Math.max(1, Math.round((CHUNK_SEC * src.sr) / src.spf)), n = src.off.length, r = T.rate / src.sr;
      let skip = Math.round((src.skip || 0) * r);   // samples the original player hid at the start
      let left = src.total ? Math.round(src.total * r) : Infinity;   // and the padding it hid at the end
      let shifted = 0;
      let tail = null;   // the end of the previous piece: the next piece is lined up against it (decoders may start a few ms off)
      for (let s = 0; s < n; s += per) {
        const e = Math.min(n, s + per), a = Math.max(0, s - LEAD), b = Math.min(n, e + LEAD);
        const parts = [];
        for (let i = a; i < b;) {   // read contiguous frames in one slice
          let j = i, end = src.off[i] + src.len[i];
          while (j + 1 < b && src.off[j + 1] === end) { j++; end += src.len[j]; }
          const bytes = new Uint8Array(await blob.slice(src.off[i], end).arrayBuffer());
          if (src.kind === 'aac') { for (let k = i, p = 0; k <= j; k++) { parts.push(adtsHead(src.adts, src.len[k]), bytes.subarray(p, p + src.len[k])); p += src.len[k]; } }
          else parts.push(bytes);
          i = j + 1;
        }
        const buf = await decodeBytes(ac, await new Blob(parts).arrayBuffer());
        const mono = await toMono(buf, T.rate);
        const g0 = Math.round(s * src.spf * r), g1 = Math.round(e * src.spf * r);
        let lead = Math.round((s - a) * src.spf * r);
        if (tail && s > 0) { const d = lineUp(mono, lead, tail, T.rate); lead += d; if (Math.abs(d) > T.rate * 0.004) shifted++; }
        let piece = new Float32Array(g1 - g0); piece.set(mono.subarray(lead, Math.min(mono.length, lead + piece.length)));
        // a piece the decoder returned too short would leave a silent hole at the joint (= a skip): stop rather than save that
        if (mono.length < lead + piece.length - Math.round(0.002 * T.rate) && e < n) throw new Error('区切りで音が欠けるおそれがあるため、変換を中止しました（元の音声はそのまま）');
        tail = piece.slice(Math.max(0, piece.length - Math.round(0.1 * T.rate)));
        if (skip) { const k = Math.min(skip, piece.length); piece = piece.slice(k); skip -= k; }
        if (piece.length > left) piece = piece.slice(0, left);
        left -= piece.length;
        if (piece.length) await feed(piece);
        onProgress(e / n, `変換しています… ${Math.round((e / n) * 100)}%`);
      }
    } else if (src && src.kind === 'wav') {
      const { fmt, data } = src, per = Math.floor((CHUNK_SEC * fmt.sr)) * fmt.align, padB = Math.floor(0.1 * fmt.sr) * fmt.align, r = T.rate / fmt.sr;
      for (let o = 0; o < data.size; o += per) {
        const a = Math.max(0, o - padB), b = Math.min(data.size, o + per + padB);
        const bytes = await blob.slice(data.off + a, data.off + b).arrayBuffer();
        const buf = await decodeBytes(ac, await new Blob([wavHead(fmt, bytes.byteLength), bytes]).arrayBuffer());
        const mono = await toMono(buf, T.rate);
        const g0 = Math.round((o / fmt.align) * r), g1 = Math.round((Math.min(data.size, o + per) / fmt.align) * r), lead = Math.round(((o - a) / fmt.align) * r);
        const piece = new Float32Array(g1 - g0); piece.set(mono.subarray(lead, Math.min(mono.length, lead + piece.length)));
        await feed(piece);
        onProgress(Math.min(1, (o + per) / data.size), `変換しています… ${Math.round(Math.min(1, (o + per) / data.size) * 100)}%`);
      }
    } else {
      // other formats: decode the whole file (kept for shorter files only)
      if (duration > 20 * 60 || blob.size > 150e6) throw new Error('この形式は20分までしか変換できません（MP3・M4A・WAVなら長くても変換できます）');
      onProgress(0.05, '音声を読み込んでいます…');
      const buf = await decodeBytes(ac, await blob.arrayBuffer());
      const mono = await toMono(buf, T.rate);
      for (let i = 0; i < mono.length; i += CHUNK_SEC * T.rate) { await feed(mono.slice(i, Math.min(mono.length, i + CHUNK_SEC * T.rate))); onProgress(i / mono.length, '変換しています…'); }
    }
    onProgress(1, '仕上げています…');
    const out = await W.end();
    if (test) return { test: true, frames: out.frames.length, inSamples: out.inSamples, kind: src?.kind || 'whole' };
    if (!out.frames.length) throw new Error('変換結果が空でした');
    const frames = out.frames.map((f) => (f instanceof Uint8Array ? f : new Uint8Array(f)));
    const firstTs = out.firstTs ?? 0;
    // priming: the encoder's start delay. A negative first timestamp tells it exactly; otherwise Apple's AAC default (2112)
    let priming = firstTs < 0 ? Math.round((-firstTs / 1e6) * T.rate) : 2112;
    priming = Math.max(0, Math.min(priming, frames.length * 1024 - out.inSamples));
    const m = m4a(frames, T.rate, out.inSamples, priming);
    const dur = out.inSamples / T.rate;
    const chk = await checkPlayable(m, dur);
    if (!chk.ok) throw new Error(`変換した音声を確認できませんでした（長さ ${chk.duration?.toFixed?.(2) ?? '?'}秒 / 予定 ${dur.toFixed(2)}秒）`);
    if (duration && Math.abs(dur - duration) > 0.05 + duration * 0.0005) throw new Error(`長さが元とずれました（${dur.toFixed(2)}秒 / 元 ${duration.toFixed(2)}秒）。元の音声はそのままです`);
    const file = new File([m], String(name).replace(/\.[^.]+$/, '') + '.m4a', { type: 'audio/mp4' });
    return { file, duration: dur, bytes: file.size, tier, kbps: T.kbps, rate: T.rate };
  } finally {
    W.stop();
    try { await Promise.race([ac.close?.(), new Promise((r) => setTimeout(r, 500))]); } catch {}
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
}

export const _m4a = m4a;   // for tests
// 1.17.2: cut [a, b] seconds out of an AAC m4a WITHOUT re-encoding. Whole AAC frames are copied (plus one frame before the cut,
// which the decoder needs to start cleanly) and the hidden start (priming) is set so playback starts exactly at a.
// Unlike a plain track copy, the original file's edit list is respected, so the cut lands where the editor showed it.
export async function cutAac(blob, a, b, name = 'audio') {
  const src = await aacIndex(blob); if (!src) throw new Error('AACの音声ではありません');
  const rate = src.sr, n = src.off.length, skip = src.skip || 0;
  const s0 = Math.max(0, Math.round(a * rate)), s1 = Math.min(n * 1024 - skip, Math.round(b * rate));
  if (s1 - s0 < rate * 0.2) throw new Error('残る部分が短すぎます');
  const k0 = Math.max(0, Math.floor((skip + s0) / 1024) - 1), k1 = Math.min(n, Math.ceil((skip + s1) / 1024) + 1);
  const frames = [];
  for (let i = k0; i < k1;) {   // read contiguous frames in one slice
    let j = i, end = src.off[i] + src.len[i];
    while (j + 1 < k1 && src.off[j + 1] === end && end - src.off[i] < (8 << 20)) { j++; end += src.len[j]; }
    const bytes = new Uint8Array(await blob.slice(src.off[i], end).arrayBuffer());
    for (let k = i, p = 0; k <= j; k++) { frames.push(bytes.slice(p, p + src.len[k])); p += src.len[k]; }
    i = j + 1;
  }
  const priming = skip + s0 - k0 * 1024, content = Math.min(s1 - s0, frames.length * 1024 - priming);
  const m = m4a(frames, rate, content, priming), dur = content / rate;
  const chk = await checkPlayable(m, dur);
  if (!chk.ok) throw new Error('カット後の音声を確認できませんでした');
  return { file: new File([m], String(name).replace(/\.[^.]+$/, '') + '.m4a', { type: 'audio/mp4' }), start: a, duration: dur };
}

// ---------------- the shared dialog: choose → convert → listen → replace ----------------
// opts: { blob, name, duration, trackIndex, lossy (already compressed?), hasOriginal (a better source exists) }
// resolves { file, tier } when the user taps 置き換える, null otherwise. The caller does the replacing (and keeps the original on failure).
const fmtB = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`);
const escT = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export async function compressDialog({ blob, name = '音声', duration = 0, trackIndex = null, lossy = false, note = '' }) {
  const sup = globalThis.__compressTest ? { ok: true, tiers: { light: true, std: true, strong: true } } : await canCompress();
  const dlg = document.createElement('dialog'); dlg.className = 'cmpdlg'; document.body.appendChild(dlg);
  const close = (v) => { dlg.close(); dlg.remove(); return v; };
  let tier = (() => { try { return localStorage.getItem('cmp-tier') || 'std'; } catch { return 'std'; } })(), result = null, urls = [], cancel = false;
  const kbpsNow = duration ? Math.round((blob.size * 8) / duration / 1000) : 0;
  return new Promise((resolve) => {
    const draw = () => {
      const e = estimate(blob.size, duration, tier);
      dlg.innerHTML = `<form method="dialog" class="dlg cmp">
        <h3>音声を圧縮</h3>
        <p class="small">${escT(name)}<br><span class="muted">今：${fmtB(blob.size)}${kbpsNow ? `・約${kbpsNow}kbps` : ''}${duration ? `・${Math.floor(duration / 60)}分${Math.round(duration % 60)}秒` : ''}</span></p>
        ${sup.ok ? `<div class="cmp-tiers">${Object.entries(TIERS).map(([k, t]) => { const x = estimate(blob.size, duration, k); return `<button type="button" class="cmp-t ${tier === k ? 'on' : ''}" data-t="${k}" ${sup.tiers[k] ? '' : 'disabled'}><b>${t.label}</b><small>AAC ${t.kbps}kbps</small><small>${x.worth ? `→ ${fmtB(x.after)}（−${Math.round(x.ratio * 100)}%）` : 'これ以上小さくなりません'}</small></button>`; }).join('')}</div>
        <p class="hint">${TIERS[tier].note}。${lossy ? '<b class="warn-text">この音声はすでに圧縮されています。もう一度圧縮すると音質の劣化が重なります。</b>' : ''}${note ? ` ${escT(note)}` : ''}</p>
        <div id="cmpProg" class="small"></div>
        <div class="row end"><button value="no" class="btn ghost">やめる</button><button type="button" id="cmpGo" class="btn primary" ${e.worth ? '' : 'disabled'}>変換して試聴</button></div>`
        : `<p class="warn-text small">${escT(sup.why)}</p><div class="row end"><button value="no" class="btn">閉じる</button></div>`}</form>`;
      dlg.querySelectorAll('.cmp-t').forEach((b) => (b.onclick = () => { tier = b.dataset.t; try { localStorage.setItem('cmp-tier', tier); } catch {} draw(); }));
      const go = dlg.querySelector('#cmpGo'); if (go) go.onclick = run;
    };
    const run = async () => {
      const prog = dlg.querySelector('#cmpProg'); dlg.querySelector('#cmpGo').disabled = true; dlg.querySelectorAll('.cmp-t').forEach((b) => (b.disabled = true));
      prog.innerHTML = '<div class="bar"><i style="width:0%"></i></div><span>準備しています…</span><button type="button" class="link small" id="cmpStop">中止</button>';
      prog.querySelector('#cmpStop').onclick = () => (cancel = true);
      try {
        result = await compressAudio(blob, { tier, name, duration, trackIndex, isCancelled: () => cancel, onProgress: (r, t) => { const i = prog.querySelector('i'); if (i) i.style.width = `${Math.round(r * 100)}%`; const sp = prog.querySelector('span'); if (sp) sp.textContent = t; } });
        preview();
      } catch (x) { prog.innerHTML = `<p class="warn-text">${escT(x.message || x)}</p><p class="hint">元の音声はそのままです。</p>`; dlg.querySelectorAll('.cmp-t').forEach((b) => (b.disabled = false)); dlg.querySelector('#cmpGo').disabled = false; cancel = false; }
    };
    const preview = () => {
      urls = [URL.createObjectURL(blob), URL.createObjectURL(result.file)];
      const red = Math.max(0, 1 - result.file.size / blob.size);
      dlg.innerHTML = `<form method="dialog" class="dlg cmp"><h3>試聴して確かめる</h3>
        <p class="small"><b>${fmtB(blob.size)} → ${fmtB(result.file.size)}</b>（−${Math.round(red * 100)}%・${TIERS[tier].label}）</p>
        <p class="small muted">元の音声</p><audio controls preload="metadata" src="${urls[0]}"></audio>
        <p class="small muted">圧縮後</p><audio controls preload="metadata" src="${urls[1]}"></audio>
        <p class="hint">子音（s・f・th）や語尾が聞き取れるか確かめてください。置き換えると元の音声は消えます（字幕・時刻・学習記録はそのまま）。</p>
        <div class="row end"><button value="no" class="btn ghost">やめる（元のまま）</button><button value="ok" class="btn primary">置き換える</button></div></form>`;
      const as = dlg.querySelectorAll('audio'); as.forEach((a, i) => (a.onplay = () => { const o = as[1 - i]; if (o && !o.paused) { a.currentTime = o.currentTime; o.pause(); } }));
    };
    dlg.onclose = () => { urls.forEach((u) => URL.revokeObjectURL(u)); const ok = dlg.returnValue === 'ok' && result; dlg.remove(); resolve(ok ? { file: result.file, tier, duration: result.duration } : null); };
    draw(); dlg.showModal();
  });
}

// Read only the MP3 frames covering a source-clock window, with decoder warm-up.
// The existing MP3 index includes the encoder delay and end padding when tagged.
export async function openMp3Windows(blob) {
  const index = await mp3Index(blob);
  const {off,len,sr,spf,skip,total} = index;
  const duration = (total || off.length*spf-skip)/sr;
  let ac;
  return {
    duration,
    async read(start,end) {
      const first = Math.round(start*sr)+skip;
      const last = Math.min(off.length*spf,Math.round(end*sr)+skip);
      if (last<=first || end-start>125) throw new Error('MP3の解析範囲を確認してください');
      const a = Math.max(0,Math.floor(first/spf)-LEAD), b = Math.min(off.length,Math.ceil(last/spf)+LEAD);
      const parts = [];
      for (let i=a;i<b;) {
        let j=i, at=off[i]+len[i];
        while (j+1<b && off[j+1]===at) { j++; at+=len[j]; }
        parts.push(blob.slice(off[i],at)); i=j+1;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      ac ||= new AC();
      let timeout;
      const bytes=await new Blob(parts,{type:'audio/mpeg'}).arrayBuffer();
      const decode=async()=>toMono(await decodeBytes(ac,bytes),16000);
      const mono=await Promise.race([decode(),new Promise((_,reject)=>{
        timeout=setTimeout(()=>reject(new Error('MP3区間の展開がタイムアウトしました')),45000);
      })]).finally(()=>clearTimeout(timeout));
      const offset = Math.round((first-a*spf)*16000/sr);
      const count = Math.round((last-first)*16000/sr);
      if (mono.length < offset+count-800) throw new Error('MP3区間の展開が途中で止まりました');
      return mono.subarray(offset,offset+count);
    },
    async close() { if (ac) await ac.close().catch(()=>{}); ac=null; },
  };
}
