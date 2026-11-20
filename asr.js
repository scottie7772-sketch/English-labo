// On-device speech recognition for Video Lab (experimental, free).
// Whisper runs in the browser through Transformers.js (loaded from a public CDN; the model is downloaded once and cached).
// Audio never leaves the device. No API key, no server.
const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
const MODELS = { en: 'onnx-community/whisper-base.en', multi: 'onnx-community/whisper-base', enFast: 'onnx-community/whisper-tiny.en', multiFast: 'onnx-community/whisper-tiny', enBest: 'Xenova/whisper-small.en', multiBest: 'Xenova/whisper-small', enHigh: 'onnx-community/distil-small.en', multiHigh: 'onnx-community/whisper-small' };
// quality: 'fast' (tiny ~40 MB) / 'acc' (base ~80 MB, default) / 'best' (small ~250 MB, slow, experimental)
export const QUALITY = { fast: '速さ優先（約40MB・精度は低め）', acc: '標準（約80MB）', high: '高精度（約170MB・標準の1.5〜2倍の時間・最高精度より軽い）', best: '最高精度（約250MB・iPhoneでは途中で止まることがあります）' };
const modelFor = (lang, q) => { const k = q === 'fast' ? 'Fast' : q === 'best' ? 'Best' : q === 'high' ? 'High' : ''; return lang === 'en' ? MODELS['en' + k] : MODELS['multi' + k]; };
const LANG_NAME = { es: 'spanish', 'zh-TW': 'chinese', 'zh-CN': 'chinese' };

const WORKER_SRC = `
import { pipeline, env } from '${TF_URL}';
env.allowLocalModels = false;
let asr = null, asrModel = null;
self.onmessage = async (e) => {
  const { audio, model, language, ts = true } = e.data;
  let lastErr = null;
  if (asr && asrModel !== model) asr = null;
  if (!asr) for (const device of e.data.devices) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, {
        device, dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: (p) => self.postMessage({ type: 'load', p }),
      });
      asrModel = model; self.postMessage({ type: 'device', device });
      break;
    } catch (err) { lastErr = err; }
  }
  if (!asr) { self.postMessage({ type: 'error', message: String(lastErr?.message || lastErr) }); return; }
  try {
    self.postMessage({ type: 'run' });
    const opt = { chunk_length_s: 30, stride_length_s: 5, ...(language && !/\.en$/.test(model) ? { language, task: 'transcribe' } : {}) };
    let out, noTs = false;
    try { out = await asr(audio, { ...opt, return_timestamps: ts }); }
    catch (err) {
      // some models (e.g. distil-small.en) fail while reading time stamps ("token_ids must be a non-empty array"): text only
      if (!ts || !/token_ids/.test(String(err?.message || err))) throw err;
      out = await asr(audio, { ...opt, return_timestamps: false }); noTs = true;
    }
    self.postMessage({ type: 'done', chunks: noTs ? [] : out.chunks || [], text: out.text || '', noTs });
  } catch (err) { self.postMessage({ type: 'error', message: String(err?.message || err) }); }
};`;

// video/audio Blob -> Float32Array, 16 kHz mono (what Whisper expects)
// WebGPU on iPhone Safari can take the whole page down during recognition; CPU (wasm) is the safe default.
// It can be turned on for testing with localStorage 'asr-webgpu' = '1'.
function useGPU() { try { return 'gpu' in navigator && localStorage.getItem('asr-webgpu') === '1'; } catch { return false; } }
export async function decodeTo16k(blob) {
  // decoding with a normal AudioContext is the path verified on iPhone (P4); it is closed right after
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const buf = await blob.arrayBuffer();
  let decoded;
  try { decoded = await new Promise((res, rej) => { const no = (e) => rej(e instanceof Error ? e : new Error('音声を取り出せませんでした（音声が入っていないか、対応していない形式です）')); const p = ac.decodeAudioData(buf, res, no); if (p?.then) p.then(res, no); setTimeout(() => rej(new Error('音声の取り出しに時間がかかりすぎました')), 120000); }); }
  finally { ac.close?.(); try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} }
  const len = Math.max(1, Math.ceil(decoded.duration * 16000));
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return { audio: rendered.getChannelData(0), duration: decoded.duration };
}

// Whisper chunks -> subtitle lines. Long chunks are split at sentence ends; noise tags like [Music] are dropped.
export function chunksToCues(chunks, duration) {
  const out = [];
  for (const ch of chunks) {
    let text = String(ch.text || '').replace(/\s+/g, ' ').trim();
    if (!text || /^[\[(（].*[\])）]$/.test(text) || /^(♪|\.\.\.)+$/.test(text)) continue;
    let [s, e] = ch.timestamp || [];
    s = s ?? (out.length ? out[out.length - 1].end : 0); e = e ?? Math.min(duration || s + 4, s + 8);
    if (e <= s) e = s + 1.5;
    const parts = text.match(/[^.!?。！？]+[.!?。！？]+["”’)]?|[^.!?。！？]+$/g)?.map((x) => x.trim()).filter(Boolean) || [text];
    if (parts.length > 1 && e - s > 5) {   // distribute time by length
      const total = parts.reduce((a, b) => a + b.length, 0); let t = s;
      for (const p of parts) { const d = ((e - s) * p.length) / total; out.push({ start: +t.toFixed(2), end: +(t + d).toFixed(2), text: p }); t += d; }
    } else out.push({ start: +s.toFixed(2), end: +e.toFixed(2), text });
  }
  return out;
}

export async function transcribe(blob, { lang = 'en', onProgress = () => {}, isCancelled = () => false } = {}) {
  onProgress('動画から音声を取り出しています…', 0.03);
  let decoded;
  try { decoded = await decodeTo16k(blob); }
  catch (e) { throw new Error('この動画の音声を読み込めませんでした（形式に対応していない可能性）: ' + (e?.message || e)); }
  if (isCancelled()) return [];
  const { audio, duration } = decoded;
  const model = lang === 'en' ? MODELS.en : MODELS.multi;
  const devices = useGPU() ? ['webgpu', 'wasm'] : ['wasm'];
  const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })), { type: 'module' });
  return new Promise((resolve, reject) => {
    const files = {};
    let runTimer = null;
    const stop = () => { clearInterval(runTimer); worker.terminate(); };
    const cancelPoll = setInterval(() => { if (isCancelled()) { clearInterval(cancelPoll); stop(); resolve([]); } }, 500);
    worker.onerror = (e) => { clearInterval(cancelPoll); stop(); reject(new Error('音声認識の部品を読み込めませんでした（ネット接続を確認してください）' + (e?.message ? '：' + e.message : ''))); };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'load' && m.p?.status === 'progress' && m.p.total) {
        files[m.p.file] = [m.p.loaded, m.p.total];
        const [a, b] = Object.values(files).reduce((x, y) => [x[0] + y[0], x[1] + y[1]], [0, 0]);
        onProgress(`音声認識モデルを準備しています（初回のみ）… ${Math.round((a / b) * 100)}%`, 0.05 + 0.35 * (a / b));
      } else if (m.type === 'device') onProgress(`モデルの準備ができました（${m.device === 'webgpu' ? 'GPU' : 'CPU'}で処理）`, 0.4);
      else if (m.type === 'run') {
        const t0 = Date.now(), est = Math.max(20, duration * 1.5) * 1000;   // rough guess just for the bar
        onProgress('文字起こし中…（動画の長さの数倍かかることがあります）', 0.42);
        runTimer = setInterval(() => onProgress(`文字起こし中…（${Math.round((Date.now() - t0) / 1000)}秒経過）`, Math.min(0.97, 0.42 + 0.55 * ((Date.now() - t0) / est))), 1000);
      } else if (m.type === 'done') { clearInterval(cancelPoll); stop(); resolve(chunksToCues(m.chunks?.length ? m.chunks : (m.text || '').trim() ? [{ text: m.text, timestamp: [0, null] }] : [], duration)); }
      else if (m.type === 'error') { clearInterval(cancelPoll); stop(); reject(new Error(m.message)); }
    };
    worker.postMessage({ audio, model, language: LANG_NAME[lang] || null, devices }, [audio.buffer]);
  });
}

// Keeps one worker (model loaded once) for several pieces of audio. run(audio16k) -> cues with times relative to the piece.
export function openTranscriber(lang = 'en', onProgress = () => {}, { fast, quality } = {}) {
  const model = modelFor(lang, quality || (fast === true ? 'fast' : 'acc'));
  const devices = useGPU() ? ['webgpu', 'wasm'] : ['wasm'];
  const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })), { type: 'module' });
  const files = {};
  let pending = null;
  worker.onerror = (e) => { pending?.reject(new Error('音声認識の部品を読み込めませんでした（ネット接続を確認してください）' + (e?.message ? '：' + e.message : ''))); pending = null; };
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'load' && m.p?.status === 'progress' && m.p.total) {
      files[m.p.file] = [m.p.loaded, m.p.total];
      const [a, b] = Object.values(files).reduce((x, y) => [x[0] + y[0], x[1] + y[1]], [0, 0]);
      onProgress(`音声認識モデルを準備しています（初回のみダウンロード）… ${Math.round((a / b) * 100)}%`);
    } else if (m.type === 'device') onProgress(`モデルの準備ができました（${m.device === 'webgpu' ? 'GPU' : 'CPU'}で処理）`);
    else if (m.type === 'done') {
      // some results come back as plain text without time stamps: keep the text (one line for the piece) instead of dropping it
      const noTime = !m.chunks?.length;
      const chunks = !noTime ? m.chunks : (m.text || '').trim() ? [{ text: m.text, timestamp: [0, pending?.duration ?? null] }] : [];
      const cues = chunksToCues(chunks, pending?.duration); if (noTime) cues.forEach((c) => (c.est = true));
      pending?.resolve(Object.assign(cues, { raw: (m.text || chunks.map((c) => c.text).join(' ')).trim(), nChunks: (m.chunks || []).length, noTime, tsFailed: !!m.noTs }));
      pending = null;
    }
    else if (m.type === 'error') { pending?.reject(new Error(m.message)); pending = null; }
  };
  return {
    run(audio, { timestamps = true } = {}) {
      const duration = audio.length / 16000;
      return new Promise((resolve, reject) => { pending = { resolve, reject, duration }; worker.postMessage({ audio, model, language: LANG_NAME[lang] || null, devices, ts: timestamps }, [audio.buffer]); });
    },
    close() { worker.terminate(); pending?.resolve([]); pending = null; },
  };
}
// split [a, b] seconds of 16 kHz audio into pieces of about `len` seconds, cutting at the quietest point near each boundary
export function pieceRanges(audio, a, b, len = 120) {
  const out = []; let s = a;
  while (b - s > Math.min(len * 1.3, 29)) {
    const target = s + len, F = 320, w = Math.min(6, len * 0.25); let best = target, bestE = Infinity;
    for (let t = target - w; t <= target + w; t += 0.02) {
      const i0 = Math.floor(t * 16000); if (i0 < 0 || i0 + F > audio.length) continue;
      let e = 0; for (let k = 0; k < F; k++) e += audio[i0 + k] * audio[i0 + k];
      if (e < bestE) { bestE = e; best = t; }
    }
    out.push([s, best]); s = best;
  }
  out.push([s, b]);
  return out;
}

// speech parts of [a, b]: long silences (> gap s) are skipped, parts are grouped into pieces of at most `len` s
export function speechPieces(audio, a, b, { len = 25, gap = 1.6 } = {}) {
  const F = 320, i0 = Math.floor(a * 16000), i1 = Math.min(audio.length, Math.floor(b * 16000));
  const rms = []; for (let i = i0; i + F <= i1; i += F) { let x = 0; for (let k = 0; k < F; k++) x += audio[i + k] * audio[i + k]; rms.push(Math.sqrt(x / F)); }
  if (!rms.length) return [[a, b]];
  const sorted = rms.slice().sort((x, y) => x - y);
  const th = Math.max(Math.min(sorted[Math.floor(sorted.length * 0.1)] * 3, sorted[Math.floor(sorted.length * 0.9)] * 0.2), sorted[Math.floor(sorted.length * 0.9)] * 0.04, 0.002);   // conservative: quiet speech must not be skipped
  const regs = []; let st = -1, last = -1;
  rms.forEach((v, k) => { if (v >= th) { if (st < 0) st = k; last = k; } else if (st >= 0 && (k - last) * 0.02 > gap) { regs.push([st, last]); st = -1; } });
  if (st >= 0) regs.push([st, last]);
  const t = (k) => a + k * 0.02;
  const out = [];
  for (const [s0, e0] of regs) {
    let s = Math.max(a, t(s0) - 0.3); const e = Math.min(b, t(e0 + 1) + 0.3);
    const prev = out[out.length - 1];
    if (prev && e - prev[0] <= len && s - prev[1] < gap) { prev[1] = e; continue; }
    if (e - s > Math.min(len * 1.3, 29)) out.push(...pieceRanges(audio, s, e, len));   // keep every piece inside one 30 s window   // long speech without pauses: cut at the quietest points
    else out.push([s, e]);
  }
  return out.length ? out : [];
}

// Fallback when decodeAudioData cannot read the file (e.g. screen recordings with several sound tracks):
// play it silently at 2x through Web Audio and record what comes out. Must be started from a tap (startNow is called in the tap).
export function captureTo16k(blob, { rate = 2, onProgress = () => {}, trackIndex = null } = {}) {
  let resolve, reject; const done = new Promise((a, b) => { resolve = a; reject = b; });
  function startNow() {
    const AC = window.AudioContext || window.webkitAudioContext; const ac = new AC();
    const v = document.createElement('video'); v.playsInline = true; v.setAttribute('playsinline', '');
    v.preservesPitch = false; v.webkitPreservesPitch = false; v.defaultPlaybackRate = rate; v.playbackRate = rate;
    const url = URL.createObjectURL(blob); v.src = url;
    const src = ac.createMediaElementSource(v);
    const proc = ac.createScriptProcessor(4096, 1, 1); proc.channelCountMode = 'explicit'; proc.channelCount = 1;
    const mute = ac.createGain(); mute.gain.value = 0;
    src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
    const parts = []; let on = false, n = 0;
    proc.onaudioprocess = (e) => { if (!on) return; const d = e.inputBuffer.getChannelData(0); parts.push(new Float32Array(d)); n += d.length; };
    // only the chosen sound track (never mix app sound and microphone)
    v.addEventListener('loadedmetadata', () => { const at = v.audioTracks; if (trackIndex != null && at && at.length > 1) for (let i = 0; i < at.length; i++) at[i].enabled = i === trackIndex; });
    v.addEventListener('playing', () => { on = true; });
    const iv = setInterval(() => { if (v.duration) onProgress(Math.min(1, v.currentTime / v.duration), v.currentTime, v.duration); }, 500);
    const fail = (msg) => { clearInterval(iv); try { v.pause(); ac.close(); } catch {} URL.revokeObjectURL(url); reject(new Error(msg)); };
    v.addEventListener('error', () => fail('この動画は再生もできませんでした'));
    v.addEventListener('ended', async () => {
      clearInterval(iv); on = false;
      const inRate = ac.sampleRate / v.playbackRate; ac.close?.(); URL.revokeObjectURL(url);   // n samples per real second cover 'rate' seconds of the file
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
      if (!n) return reject(new Error('音声を取り出せませんでした（無音）'));
      const all = new Float32Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      const duration = n / inRate;
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const off = new OAC(1, Math.max(1, Math.ceil(duration * 16000)), 16000);
      const buf = off.createBuffer(1, n, Math.min(384000, inRate)); buf.getChannelData(0).set(all);
      const bs = off.createBufferSource(); bs.buffer = buf; bs.connect(off.destination); bs.start();
      const r = await off.startRendering();
      resolve({ audio: r.getChannelData(0), duration });
    });
    ac.resume?.(); v.play().catch((e) => fail('再生を始められませんでした：' + (e?.name || e)));
  }
  return { startNow, done };
}

// Whisper sometimes returns nothing for a piece that starts in the middle of narration over music.
// Retry: (1) ~8 s sub-pieces cut at quiet points, (2) the whole piece without time stamps (time spread by length).
export async function recognisePiece(tr, audio, ps, pe, { onRetry = () => {} } = {}) {
  const cut = (a, b) => audio.slice(Math.floor(a * 16000), Math.floor(b * 16000));
  const abs = (cues, a, b) => cues.map((c) => ({ start: +(a + c.start).toFixed(2), end: +Math.min(b, a + c.end).toFixed(2), text: c.text, ...(c.est ? { est: true } : {}) })).filter((c) => c.end - c.start > 0.05);
  // this model gives no time stamps: recognise ~8 s parts so each line's time is close
  if (tr.noTime && pe - ps > 10) {
    const out = [], raw = [];
    for (const [a, b] of pieceRanges(audio, ps, pe, 8)) { const c = await tr.run(cut(a, b), { timestamps: false }); raw.push(c.raw || ''); out.push(...abs(c, a, b)); }
    return Object.assign(out, { raw: raw.join(' '), how: '時刻なし・短く区切って（時刻は推定）' });
  }
  let cues = await tr.run(cut(ps, pe)); const raw = [cues.raw || ''];
  if (cues.tsFailed && cues.length && pe - ps > 10) { tr.noTime = true; return recognisePiece(tr, audio, ps, pe, { onRetry }); }
  if (cues.length) return Object.assign(abs(cues, ps, pe), { raw: raw.join(' '), how: cues.noTime ? '時刻なし（時刻は推定）' : '通常' });
  if (pe - ps > 10) {
    onRetry('短く区切ってやり直しています…');
    const out = [];
    for (const [a, b] of pieceRanges(audio, ps, pe, 8)) { const c = await tr.run(cut(a, b)); raw.push(c.raw || ''); out.push(...abs(c, a, b)); }
    if (out.length) return Object.assign(out, { raw: raw.join(' '), how: '短く区切って再試行' });
  }
  onRetry('時刻なしでやり直しています…');
  const c2 = await tr.run(cut(ps, pe), { timestamps: false }); raw.push(c2.raw || '');
  const text = (c2.raw || c2.map((x) => x.text).join(' ')).trim();
  if (!text) return Object.assign([], { raw: raw.join(' ').trim(), how: '空' });
  const parts = text.match(/[^.!?]+[.!?]+["”’)]?|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) || [text];
  const total = parts.reduce((a, b) => a + b.length, 0); let t = ps; const out = [];
  for (const p of parts) { const d = ((pe - ps) * p.length) / total; out.push({ start: +t.toFixed(2), end: +(t + d).toFixed(2), text: p, est: true }); t += d; }
  return Object.assign(out, { raw: raw.join(' '), how: '時刻なしで再試行（時刻は推定）' });
}
