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
export async function transcribeAudio(audio, { lang = 'en', fast = true, from = 0, to = null, onProgress = () => {}, onPiece = () => {}, isCancelled = () => false } = {}) {
  highPass(audio);
  const end = to ?? audio.length / 16000;
  const pieces = speechPieces(audio, from, end, { len: 45 });
  if (!pieces.length) throw stage('話し声の検出', '話し声が見つかりませんでした（無音か、音量がとても小さい）');
  const total = pieces.reduce((a, [x, y]) => a + y - x, 0);
  const tr = openTranscriber(lang, (m) => onProgress(m, null), { fast });
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
