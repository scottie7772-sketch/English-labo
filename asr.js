// On-device speech recognition for Video Lab (experimental, free).
// Whisper runs in the browser through Transformers.js (loaded from a public CDN; the model is downloaded once and cached).
// Audio never leaves the device. No API key, no server.
const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
const MODELS = { en: 'onnx-community/whisper-base.en', multi: 'onnx-community/whisper-base', enFast: 'onnx-community/whisper-tiny.en', multiFast: 'onnx-community/whisper-tiny' };
const LANG_NAME = { es: 'spanish', 'zh-TW': 'chinese', 'zh-CN': 'chinese' };

const WORKER_SRC = `
import { pipeline, env } from '${TF_URL}';
env.allowLocalModels = false;
let asr = null, asrModel = null;
self.onmessage = async (e) => {
  const { audio, model, language } = e.data;
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
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, ...(language ? { language, task: 'transcribe' } : {}) });
    self.postMessage({ type: 'done', chunks: out.chunks || [], text: out.text || '' });
  } catch (err) { self.postMessage({ type: 'error', message: String(err?.message || err) }); }
};`;

// video/audio Blob -> Float32Array, 16 kHz mono (what Whisper expects)
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
  const devices = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
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
      } else if (m.type === 'done') { clearInterval(cancelPoll); stop(); resolve(chunksToCues(m.chunks, duration)); }
      else if (m.type === 'error') { clearInterval(cancelPoll); stop(); reject(new Error(m.message)); }
    };
    worker.postMessage({ audio, model, language: LANG_NAME[lang] || null, devices }, [audio.buffer]);
  });
}

// Keeps one worker (model loaded once) for several pieces of audio. run(audio16k) -> cues with times relative to the piece.
export function openTranscriber(lang = 'en', onProgress = () => {}, { fast = true } = {}) {
  const model = lang === 'en' ? (fast ? MODELS.enFast : MODELS.en) : (fast ? MODELS.multiFast : MODELS.multi);
  const devices = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
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
    else if (m.type === 'done') { pending?.resolve(chunksToCues(m.chunks, pending.duration)); pending = null; }
    else if (m.type === 'error') { pending?.reject(new Error(m.message)); pending = null; }
  };
  return {
    run(audio) {
      const duration = audio.length / 16000;
      return new Promise((resolve, reject) => { pending = { resolve, reject, duration }; worker.postMessage({ audio, model, language: LANG_NAME[lang] || null, devices }, [audio.buffer]); });
    },
    close() { worker.terminate(); pending?.resolve([]); pending = null; },
  };
}
// split [a, b] seconds of 16 kHz audio into pieces of about `len` seconds, cutting at the quietest point near each boundary
export function pieceRanges(audio, a, b, len = 120) {
  const out = []; let s = a;
  while (b - s > len * 1.3) {
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
export function speechPieces(audio, a, b, { len = 60, gap = 1.2 } = {}) {
  const F = 320, i0 = Math.floor(a * 16000), i1 = Math.min(audio.length, Math.floor(b * 16000));
  const rms = []; for (let i = i0; i + F <= i1; i += F) { let x = 0; for (let k = 0; k < F; k++) x += audio[i + k] * audio[i + k]; rms.push(Math.sqrt(x / F)); }
  if (!rms.length) return [[a, b]];
  const sorted = rms.slice().sort((x, y) => x - y);
  const th = Math.max(sorted[Math.floor(sorted.length * 0.1)] * 3, sorted[Math.floor(sorted.length * 0.9)] * 0.08, 0.004);
  const regs = []; let st = -1, last = -1;
  rms.forEach((v, k) => { if (v >= th) { if (st < 0) st = k; last = k; } else if (st >= 0 && (k - last) * 0.02 > gap) { regs.push([st, last]); st = -1; } });
  if (st >= 0) regs.push([st, last]);
  const t = (k) => a + k * 0.02;
  const out = [];
  for (const [s0, e0] of regs) {
    let s = Math.max(a, t(s0) - 0.3); const e = Math.min(b, t(e0 + 1) + 0.3);
    const prev = out[out.length - 1];
    if (prev && e - prev[0] <= len && s - prev[1] < gap) { prev[1] = e; continue; }
    if (e - s > len * 1.3) out.push(...pieceRanges(audio, s, e, len));   // long speech without pauses: cut at the quietest points
    else out.push([s, e]);
  }
  return out.length ? out : [];
}
