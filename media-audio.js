// Shared sound pipeline for English Labo's video lab and the studio:
// save a real copy of a picked file, take the right sound track out, turn it into text piece by piece.
import { decodeTo16k, openTranscriber, speechPieces } from './asr.js';
import { probe, audioTracks, canExtract, extractTrack, chooseTrack } from './media-probe.js';

// iPhone Safari can keep only a reference to the picked file (a temporary copy that iOS deletes later);
// reading it into memory in pieces makes a real copy that stays readable
// Saved as a File (not a Blob made from other blobs): those came back unreadable after reopening the app on iPhone,
// while File objects (as the studio saves them) stayed readable.
export async function copyBlob(file, onProgress = () => {}, { name = file.name || 'media', type = file.type || '' } = {}) {
  const parts = [], N = 8 * 1024 * 1024;
  for (let o = 0; o < file.size; o += N) { parts.push(await file.slice(o, Math.min(file.size, o + N)).arrayBuffer()); onProgress(Math.min(1, (o + N) / file.size)); }
  return new File(parts, name, { type });
}
// several sound tracks: which one has speech (index among sound tracks). null when there is only one.
export async function speechTrackIndex(blob, name = '', onStep = () => {}) {
  if (!isContainer(blob, name)) return null;
  let info; try { info = await probe(blob); } catch { return null; }
  const at = audioTracks(info); if (at.length < 2) return null;
  onStep(`音声が${at.length}本あります。話し声のある方を選んでいます…`);
  const r = await chooseTrack(blob, info, decodeTo16k);
  const t = r.chosen || at[0];
  return { index: Math.max(0, at.indexOf(t)), id: t.id, count: at.length, reason: r.reason, auto: r.auto };
}
// one stored copy of a picked video: real bytes (not a reference), and — if it has several sound tracks —
// only the speech track kept, so every player plays the right sound (no reliance on audio-track switching)
export async function saveVideoCopy(file, { onStep = () => {} } = {}) {
  const { keepOneAudioTrack } = await import('./media-probe.js');
  const sp = await speechTrackIndex(file, file.name, onStep).catch(() => null);
  if (sp) {
    try { onStep('話し声の音声だけを残して保存しています…'); const f = await keepOneAudioTrack(file, sp.id, { name: file.name, type: file.type || 'video/mp4', onProgress: (r) => onStep(`保存中… ${Math.round(r * 100)}%`) }); if (f) return { blob: f, info: { count: sp.count, kept: sp.index, reason: sp.reason, auto: sp.auto } }; } catch {}
  }
  const blob = await copyBlob(file, (r) => onStep(`保存中… ${Math.round(r * 100)}%`), { type: file.type || 'video/mp4' });
  return { blob, info: sp ? { count: sp.count, kept: null, reason: sp.reason } : null, trackIndex: sp ? sp.index : null };
}
// several sound tracks (screen recordings: app sound + microphone): take the one with speech out as its own .m4a (no re-encoding).
// Returns null when there is only one track (or the file is not mp4/mov).
export async function separateSpeechTrack(blob, name = '', onStep = () => {}) {
  if (!isContainer(blob, name)) return null;
  let info; try { info = await probe(blob); } catch { return null; }
  const at = audioTracks(info); if (at.length < 2) return null;
  onStep(`音声が${at.length}本あります。話し声のある方を選んでいます…`);
  const r = await chooseTrack(blob, info, decodeTo16k);
  const t = r.chosen || at[0]; if (!canExtract(t)) return null;
  onStep('選んだ音声を取り出しています…');
  const x = await extractTrack(blob, t);
  // stored as one plain byte array (not a Blob built from other blobs/views), the form that stays readable after reopening
  return { file: new File([await x.blob.arrayBuffer()], (name || 'audio').replace(/\.[^.]+$/, '') + '.m4a', { type: 'audio/mp4' }), index: at.indexOf(t), count: at.length, reason: r.reason, auto: r.auto };
}
export async function readable(blob) {
  if (!blob) return false;
  try { await blob.slice(0, 16).arrayBuffer(); return true; } catch { return false; }
}
const stage = (name, e) => Object.assign(new Error(`${name}：${e?.message || e}`), { stage: name });
const isContainer = (blob, name = '') => /mp4|quicktime|m4a/.test(blob?.type || '') || /\.(mp4|m4v|mov|m4a)$/i.test(name);

// → { audio (16 kHz mono), duration, method, track: { index, count, reason } }
export async function audio16kFromBlob(blob, { name = '', trackIndex = null, onStep = () => {} } = {}) {
  if (!(await readable(blob))) throw stage('保存データの読み込み', '動画データが読めなくなっています（iPhoneが一時ファイルを消した可能性）。動画を選び直してください');
  if (isContainer(blob, name)) {
    let info = null; try { onStep('音声トラックを調べています…'); info = await probe(blob); } catch {}
    const at = info ? audioTracks(info) : [];
    if (info && !at.length) throw stage('音声トラックの確認', 'この動画には音声が入っていません');
    if (at.length) {
      let t = at[trackIndex ?? 0], reason = '音声トラックは1本';
      if (at.length > 1 && trackIndex == null) { onStep(`音声が${at.length}本あります。話し声のある方を選んでいます…`); const r = await chooseTrack(blob, info, decodeTo16k); if (r.chosen) { t = r.chosen; reason = r.reason; } }
      if (canExtract(t)) {
        let x; try { onStep('音声を取り出しています…'); x = await extractTrack(blob, t); } catch (e) { throw stage('音声の取り出し', e); }
        try { onStep('音声を展開しています…'); const d = await decodeTo16k(x.blob); return { ...d, method: 'track', track: { index: at.indexOf(t), count: at.length, reason } }; }
        catch (e) { throw stage('音声の展開', e); }
      }
    }
  }
  try { onStep('音声を展開しています…'); const d = await decodeTo16k(blob); return { ...d, method: 'decode', track: null }; }
  catch (e) { throw stage('音声の展開', e); }
}

function highPass(a, fc = 80) { const rc = 1 / (2 * Math.PI * fc), dt = 1 / 16000, al = rc / (rc + dt); let py = 0, px = a[0] || 0; for (let i = 0; i < a.length; i++) { const x = a[i]; py = al * (py + x - px); px = x; a[i] = py; } return a; }

// speech parts of the audio are recognised one by one (silences skipped). onPiece(cues) lets callers save as they go.
export async function transcribeAudio(audio, { lang = 'en', quality = 'acc', from = 0, to = null, onProgress = () => {}, onPiece = () => {}, isCancelled = () => false } = {}) {
  highPass(audio);
  const end = to ?? audio.length / 16000;
  const pieces = speechPieces(audio, from, end, { len: 25 });
  if (!pieces.length) throw stage('話し声の検出', '話し声が見つかりませんでした（無音か、音量がとても小さい）');
  const total = pieces.reduce((a, [x, y]) => a + y - x, 0);
  const tr = openTranscriber(lang, (m) => onProgress(m, null), { quality });
  const all = [], raw = []; let done = 0;
  try {
    for (const [ps, pe] of pieces) {
      if (isCancelled()) break;
      onProgress(`文字起こし中… ${Math.round((done / total) * 100)}%`, done / total);
      let cues; try { cues = await tr.run(audio.slice(Math.floor(ps * 16000), Math.floor(pe * 16000))); } catch (e) { throw stage('文字起こし', e); }
      raw.push(cues.raw || '');
      const abs = cues.map((c) => ({ start: +(ps + c.start).toFixed(2), end: +Math.min(pe, ps + c.end).toFixed(2), text: c.text })).filter((c) => c.end - c.start > 0.05);
      all.push(...abs); onPiece(abs); done += pe - ps;
    }
  } finally { tr.close(); }
  if (!all.length && !isCancelled()) throw stage('文字起こし', `文字にできる英語がありませんでした（認識された内容：${raw.join(' ').trim().slice(0, 80) || 'なし'}）`);
  return all;
}

// ---- start / end trimming (screen-recording sounds, silence); shared by the studio and the video lab ----
export const frameRms = (a) => { const F = 320, r = []; for (let i = 0; i + F <= a.length; i += F) { let x = 0; for (let k = 0; k < F; k++) x += a[i + k] * a[i + k]; r.push(Math.sqrt(x / F)); } return r; };
export const frameZcr = (a) => { const F = 320, r = []; for (let i = 0; i + F <= a.length; i += F) { let z = 0; for (let k = i + 1; k < i + F; k++) if ((a[k] >= 0) !== (a[k - 1] >= 0)) z++; r.push(z / F); } return r; };
// rms / zcr: 20 ms frames from the edge inward. Returns seconds to cut from that edge.
export function edgeCut(rms, zcr = []) {
  if (rms.length < 10) return { cut: 0, why: '' };
  const s = rms.slice().sort((a, b) => a - b), floor = s[Math.floor(s.length * 0.1)];
  const p90 = s[Math.floor(s.length * 0.9)];
  const th = Math.max(Math.min(floor * 4, p90 * 0.3), p90 * 0.12, 0.004);   // (background music under speech must not count as silence)
  // 1) an electronic tone (start/stop sound): steady, high-pitched for 80–900 ms within the first 3 s — even when speech follows at once
  // (a fading tone counts: its loudness drops fast but its pitch stays the same; measured on a real iPhone recording: ~1.2 kHz, 0.45 s)
  const lim = Math.min(rms.length, 150), thTone = Math.max(floor * 3, 0.0004);
  for (let i = 3; i < lim; i++) {   // the first 60 ms often hold a click: skip
    let j = i; while (j < rms.length && rms[j] >= thTone && zcr[j] >= 0.09 && zcr[j] <= 0.6 && (j === i || Math.abs(zcr[j] - zcr[j - 1]) < 0.025)) j++;
    const len = (j - i) * 0.02;
    if (len >= 0.08 && len <= 0.9) {   // cut just after the tone (+ margin); if silence follows, up to just before the speech
      let k = j; while (k < rms.length && k < j + 75 && rms[k] < th) k++;
      return { cut: Math.max(j * 0.02 + 0.12, k > j ? k * 0.02 - 0.15 : 0), why: `電子音（${len.toFixed(1)}秒）` };
    }
    if (j > i) i = j;
  }
  // 2) a short sound followed by silence
  let i = 3; while (i < rms.length && rms[i] < th) i++;
  const lead = i;
  let j = i; while (j < rms.length && rms[j] >= th) j++;
  let k = j; while (k < rms.length && rms[k] < th) k++;
  const burst = (j - i) * 0.02, gap = (k - j) * 0.02;
  if (i < rms.length && burst > 0.04 && burst <= 0.9 && gap >= 0.25 && k < rms.length) return { cut: Math.max(0, k * 0.02 - 0.15), why: `短い音（${burst.toFixed(1)}秒）とその後の無音` };
  // 3) silence
  if (lead * 0.02 >= 0.3) return { cut: Math.max(0, lead * 0.02 - 0.15), why: '無音' };
  return { cut: 0, why: '' };
}
// when nothing is found in a screen recording: cut a fixed length (the usual start/stop sound), set by the user
export const isScreenRec = (name) => /screen\s*recording|画面収録|RPReplay/i.test(name || '');
// the iPhone screen-recording sound lasts about 0.9 s (measured by the user)
export const defaultCut = () => { try { return +(localStorage.getItem('st-defCut2') ?? 0.9); } catch { return 0.9; } };

// seconds [start, end] to keep, looking at the first / last few seconds of the chosen sound track
export async function findEdgesBlob(blob, { name = '', trackIndex = null, duration = 0 } = {}) {
  let a0, a1, D = duration;
  const info = isContainer(blob, name) ? await probe(blob).catch(() => null) : null;
  const at = info ? audioTracks(info) : [];
  const t = at[trackIndex ?? 0];
  if (t && canExtract(t)) {
    D = D || t.duration; const W = Math.min(6, D / 3);
    a0 = (await decodeTo16k((await extractTrack(blob, t, 0, W)).blob)).audio;
    const x = await extractTrack(blob, t, Math.max(0, D - W), D); const d1 = await decodeTo16k(x.blob); a1 = d1.audio; D = x.start + d1.duration;
  } else { const { audio, duration: d } = await decodeTo16k(blob); D = d; const W = Math.min(6, D / 3) * 16000; a0 = audio.subarray(0, W); a1 = audio.subarray(Math.max(0, audio.length - W)); }
  let st = edgeCut(frameRms(a0), frameZcr(a0)); const en = edgeCut(frameRms(a1).reverse(), frameZcr(a1).reverse());
  const dc = defaultCut(); if (isScreenRec(name) && dc > 0 && st.cut < dc) st = { cut: dc, why: `画面収録の音 ${dc}秒` };
  return { start: +st.cut.toFixed(2), end: +(D - en.cut).toFixed(2), whyStart: st.why, whyEnd: en.why, duration: D };
}
