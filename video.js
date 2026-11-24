import { releaseVideoMedia } from './video-media-ref.js';
import { readScriptJa, planScriptJa } from './video-script-ja.js';
// Phase 6: Video Lab (local videos + SRT/VTT subtitles + word registration linked to video position)
import { db, uid, getSetting, setSetting } from './db.js';
import { $, $$, esc, toast, confirmDialog, go, swipeToDelete } from './ui.js';
import { icon } from './icons.js';
import { L, curLang, langAttr } from './langs.js';
import { pickWordsDialog } from './pick.js';
import { headKey, wordsByHead, findDuplicate, newWord, newSense, saveWord, splitList } from './words.js';
import { clozeHTML, toggleToken, candidates } from './cloze.js';
import { translationRows, planTranslations } from './video-translations.js';
import { readVideoJa, videoJaView, videoJaSource, compareVideoCues, parseJaPatch, cueStamps, saveVideoJa, removeVideoJaInTx, studioJaPatch } from './video-ja.js';
import { fingerprint } from './common-pack.js';
import { recordAnswer } from './judge.js';

// ---------- subtitles ----------
const TIME = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
function toSec(t) {
  const p = t.replace(',', '.').split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
export function parseSubs(text) {
  const out = [];
  const blocks = String(text).replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => TIME.test(l));
    if (i < 0) continue;
    const m = lines[i].match(TIME);
    const txt = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    if (txt) out.push({ start: toSec(m[1]), end: toSec(m[2]), text: txt });
  }
  return out.sort((a, b) => a.start - b.start);
}
function srtTime(s) {
  const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function toSRT(cues, field) {
  return cues.filter((c) => c[field]).map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c[field]}\n`).join('\n');
}
const fmtT = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const parseT = (v) => { v = String(v).trim(); if (!v) return NaN; if (v.includes(':')) { const [m, s] = v.split(':'); return +m * 60 + +s; } return +v; };
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
async function cuesOf(videoId) {
  const cues = await db.byIndex('cues', 'videoId', videoId);
  return cues.sort(compareVideoCues);
}
async function replaceCues(videoId, cues) {
  const old = await db.byIndex('cues', 'videoId', videoId);
  await db.tx(['cues'], 'readwrite', (t) => { const os = t.objectStore('cues'); old.forEach((c) => os.delete(c.id)); cues.forEach((c) => os.put(c)); });
}
function studioCue(it, start, offset = 0) {
  const segments = it.segments.filter(segment => segment.media === it.segments[0].media)
    .map(segment => ({ start: offset + segment.start, end: offset + segment.end }));
  return {
    itemId: it.id, start, end: it.role === 'example' ? segments[0].end : segments.at(-1).end, en: it.text || '', ja: it.ja || '',
    segments, sourceSegments: it.segments, studySet: it.studySet, role: it.role, sync: it.sync, ...(it.jaRemoved ? { jaRemoved: true } : {}),
    ...(it.holes?.length ? { holes: it.holes } : {}),
  };
}
function preserveCueEdits(c, old) {
  c.id = old.id;
  c.translationRevision = old.translationRevision;
  if (old.dict) c.dict = old.dict;
  if (old.enEdited) Object.assign(c, { en: old.en, enEdited: true, holes: old.holes || [] });
  if (old.jaEdited || (!c.ja && old.ja && !c.jaRemoved)) Object.assign(c, { ja: old.ja, jaEdited: old.jaEdited });
  if (old.timeEdited) Object.assign(c, { start: old.start, end: old.end, segments: old.segments, timeEdited: true });
  if (old.en === c.en && old.holes?.length) c.holes = old.holes;
  if (cueStamps([old]).get(old.id) !== cueStamps([c]).get(c.id)) {
    c.translationRevision = uid('rev_');
    if (old.ja && (!c.ja || c.ja === old.ja)) c.legacyJaReview = true;
  } else if (old.legacyJaReview) c.legacyJaReview = true;
}

// a studio material (from a pack file, or sent directly by the studio inside this app) → video lab.
// The same material again: subtitles are replaced in place, learning records kept. getFile(m) → Blob of a media file or null.
export async function importMaterial(manifest, mat, getFile, { askUpdate = true, direct = false, update: updateExisting = true } = {}) {
  const { copyBlob } = await import('./media-audio.js');
  // same material imported before (same studio set): update it in place, keeping the learning records
  const all = (await db.all('videos')).map(({ blob, ...x }) => x);
  const mine = all.filter((x) => x.from?.material && x.from.material === manifest.materialId && x.kind !== 'multi');
  const oldParent = all.find((x) => x.kind === 'multi' && x.from?.material === manifest.materialId);
  const findOld = (m) => mine.find((x) => x.from.media === m.id) || mine.find((x) => !x.from.media && (x.name === manifest.title || x.name === `${manifest.title}（${m.name}）`));
  const withText = (m) => mat.items.some(it => (it.text || it.ja) && it.segments?.some(g => g.media === m.id));
  const plan = mat.media.filter(withText).map((m) => ({ m, old: findOld(m) }));
  const existingComplete = mine.some(v => v.from?.importComplete) ||
    (mine.length && mine.every(v => v.from?.importComplete == null) && plan.length > 0 && plan.every(p => p.old) && (plan.length === 1 || oldParent));
  if (direct && !updateExisting && existingComplete) return { skipped: true, reason: '登録済み' };
  const mediaById = new Map(plan.map(({ m }) => [m.id, m]));
  const mediaOrder = [...new Set(mat.items.flatMap(it => (it.segments || []).map(g => g.media)).filter(id => mediaById.has(id)))];
  if (direct && existingComplete && (mine.length !== plan.length || plan.some(p => !p.old))) {
    throw Object.assign(Error('音声ファイルの構成が変わっています。既存の再生位置を保護するため更新を保留しました'), { skip: true });
  }
  const layoutMatches = oldParent?.parts?.length === mediaOrder.length && oldParent.parts.every((part, i) => {
    const duration = mediaById.get(part.media)?.duration;
    return part.media === mediaOrder[i] && (!duration || Math.abs(duration - part.dur) < .01);
  });
  if (direct && existingComplete && oldParent && !layoutMatches) {
    throw Object.assign(Error('音声ファイルの順序または長さが変わっています。既存の再生位置を保護するため更新を保留しました'), { skip: true });
  }
  const protectedCues = async (video, previous, used, fresh) => {
    if (!direct && !Array.isArray(mat.jaSpans)) return;
    const translations = await readVideoJa(video.id);
    const edited = new Set(translations.filter(link => link.cueId && !link.studio).map(link => link.cueId));
    for (const cue of previous) {
      if (!used.has(cue.id) && (cue.enEdited || cue.timeEdited || cue.jaEdited || edited.has(cue.id))) fresh.push(cue);
    }
  };
  const transferJa = async (v, cues) => {
    if (!Array.isArray(mat.jaSpans)) return;
    const text = new Map(mat.items.map(item => [item.id, item.text]));
    const patch = studioJaPatch(cues.filter(cue => cue.en === text.get(cue.itemId)), mat.jaSpans);
    if (patch.size || v.from?.hadStudioJa) await saveVideoJa(v.id, patch, cueStamps(cues), { fromStudio: true, replaceStudio: true });
    v.from.hadStudioJa = true;
  };
  if (direct) for (const { m, old } of plan) {
    if (old && m.size && old.from?.mediaSize && m.size !== old.from.mediaSize) {
      throw Object.assign(Error(`元の音声が変更されています。手動調整を保護するため確認してください（${m.name}）`), { skip: true });
    }
    if (m.included || (old && await videoBlob(old))) continue;
    throw Object.assign(Error(`音声ファイルを選び直してください（${m.name}）`), { skip: true });
  }
  let update = false;
  if (plan.some((p) => p.old)) {
    update = !askUpdate || await confirmDialog({ title: 'すでにある教材です', body: `<p>「${esc(manifest.title)}」は前に取り込んでいます。字幕を新しい内容に入れ替えますか？</p><p class="hint">入れ替えても、単語帳の「元の動画」へのリンク・再生位置・固有名詞・変わっていない行のディクテーション記録は残ります。</p>`, okLabel: '入れ替える', cancelLabel: '別の教材として追加' });
    if (!update) plan.forEach((p) => (p.old = null));
  }
  const missing = plan.filter((p) => !p.old && !p.m.included);
  if (!plan.some((p) => p.old || p.m.included)) throw new Error('このパックには動画・音声が入っていません。スタジオで「動画・音声も含める」を選んで書き出し直してください');
  let first = null, nUpd = 0, nNew = 0; const made = [];
  for (const { m, old } of plan) {
    if (!old && !m.included) continue;
    toast('取り込み中…', 10000);
    let v, freshBlob = null;
    const openSource = async () => {
      const raw = await getFile(m);
      if (!raw) throw Error(`音声ファイルを開けません（${m.name}）`);
      return raw;
    };
    if (old) {
      v = await db.get('videos', old.id);
      if (m.included && !direct && m.size && v.from?.mediaSize && m.size !== v.from.mediaSize) {   // the sound itself changed in the studio: replace it
        const raw = await openSource(); const { saveVideoCopy } = await import('./media-audio.js');
        const sv = m.kind === 'video' ? await saveVideoCopy(new File([raw], m.name, { type: m.mime || 'video/mp4' }), { onStep: (x) => toast(x, 10000) }) : { blob: await copyBlob(raw, () => {}, { name: m.name, type: m.mime || 'audio/mp4' }) };
        freshBlob = sv.blob; Object.assign(v, { size: sv.blob.size, mime: m.mime || v.mime, duration: m.duration || v.duration, audioChecked: true, audioFixed: true }); if (sv.info) v.audioInfo = sv.info; if (sv.trackIndex != null) v.audioTrack = sv.trackIndex;
      }
      v.from = { ...v.from, pack: manifest.packId, media: m.id, mediaSize: m.size || v.from?.mediaSize, updatedAt: Date.now() };
      nUpd++;
    } else {
      v = { id: uid('v_'), lang: manifest.lang || curLang(), name: plan.length > 1 ? `${manifest.title}（${m.name}）` : manifest.title,
        mime: m.mime || 'video/mp4', size: m.size || 0, duration: m.duration || 0, lastTime: 0, createdAt: Date.now(),
        from: { pack: manifest.packId, material: manifest.materialId, media: m.id, mediaSize: m.size } };
      if (!direct) {
        const raw = await openSource(), { saveVideoCopy } = await import('./media-audio.js');
        const sv = m.kind === 'video' ? await saveVideoCopy(new File([raw], m.name, { type: m.mime || 'video/mp4' }), { onStep: x => toast(x, 10000) }) :
          { blob: await copyBlob(raw, r => toast(`取り込み中… ${Math.round(r * 100)}%`, 10000), { name: m.name, type: m.mime || 'audio/mp4' }) };
        freshBlob = sv.blob; v.size = sv.blob.size;
        if (sv.info) v.audioInfo = sv.info;
        if (sv.trackIndex != null) v.audioTrack = sv.trackIndex;
        v.audioChecked = true; v.audioFixed = true;
      }
      nNew++;
    }
    if (direct) {
      v.from.importComplete = false;
      if (!old || !await videoBlob(v)) {
        const raw = await openSource();
        let key = m.existingMediaKey;
        if (!key || !(await db.get('vblobs', key))?.blob) {
          const fp = await fingerprint(raw);
          key = `studio-media:${m.id}:${fp.head}:${fp.tail}:${fp.size}`;
          if (!await db.get('vblobs', key)) await putVideoBlob(key, new File([raw], m.name, { type: m.mime || raw.type }));
        }
        v.mediaRef = key;
        v.size = raw.size;
        v.duration = m.duration || v.duration;
        v.audioChecked = true;
        v.audioFixed = true;
        if (m.trackIndex != null) v.audioTrack = m.trackIndex;
      }
    }
    if (mat.set?.folder != null || direct) v.folder = mat.set?.folder || '';
    // the studio's cut (start/end) = the range covered by the items: playback stays inside it
    const segs = mat.items.flatMap((it) => (it.segments || []).filter((g) => g.media === m.id));
    delete v.trim;
    const split = mat.set?.splitRange;
    if (split?.sourceId === m.id && Number.isFinite(split.start) && Number.isFinite(split.end) && split.end > split.start) {
      // A split material must use its explicit source bounds, not the first/last subtitle.
      v.trim = { start: split.start, end: Math.min(split.end, m.duration || split.end), why: 'スタジオの分割範囲' };
    } else if (segs.length) {
      const a0 = Math.min(...segs.map((g) => g.start)), a1 = Math.max(...segs.map((g) => g.end));
      if (a0 > 0.05 || (m.duration && a1 < m.duration - 0.05)) v.trim = { start: a0, end: a1, why: 'スタジオのカット' };
    }
    v.materialType = mat.set?.materialType || v.materialType;
    if (freshBlob) await putVideoBlob(v.id, freshBlob);
    await saveVideoMeta(v);
    const fresh = mat.items.filter((it) => it.segments?.[0]?.media === m.id && (it.text || it.ja) && !v.removedStudioItems?.includes(it.id))
      .map((it, order) => ({ id: uid('c_'), videoId: v.id, ...(direct || mat.jaSpans ? { studioOrder: order } : {}), ...studioCue(it, it.segments[0].start) }))
      .sort((a, b) => a.start - b.start);
    if (old) {   // keep cue ids (word links) and records of lines that still exist
      const prev = await db.byIndex('cues', 'videoId', v.id); const used = new Set();
      for (const c of fresh) {
        const o = prev.find((x) => !used.has(x.id) && x.itemId && x.itemId === c.itemId) || prev.find((x) => !used.has(x.id) && !x.itemId && x.en && x.en === c.en);
        if (!o) continue; used.add(o.id);
        preserveCueEdits(c, o);
      }
      await protectedCues(v, prev, used, fresh);
    }
    if (v.trim) for (const cue of fresh) if (cue.timeEdited) {
      v.trim.start = Math.min(v.trim.start, cue.start);
      v.trim.end = Math.max(v.trim.end, cue.end);
    }
    await replaceCues(v.id, fresh);
    await transferJa(v, fresh);
    if (!direct && Array.isArray(mat.jaSpans)) await saveVideoMeta(v);
    first ||= v; made.push({ m, v });
  }
  // several sound files in one material (a script with its audio pieces): also one entry that plays them as one timeline, in script order
  const medias = mat.media.filter(withText);
  if (medias.length > 1 && made.length === medias.length) {
    let off = 0; const parts = mediaOrder.map((mid) => { const x = made.find((y) => y.m.id === mid); const dur = x.m.duration || x.v.duration || 0; const p = { videoId: x.v.id, media: mid, offset: +off.toFixed(3), dur }; off += dur; return p; });
    const P = (update && oldParent) ? { ...(await db.get('videos', oldParent.id)) } : { id: uid('v_'), lang: manifest.lang || curLang(), lastTime: 0, createdAt: Date.now() };
    Object.assign(P, { kind: 'multi', name: manifest.title, parts, duration: off, size: 0, mime: 'audio/mp4', audioChecked: true, audioFixed: true, from: { ...P.from, material: manifest.materialId, multi: true, pack: manifest.packId, updatedAt: Date.now() } });
    if (direct) P.from.importComplete = false;
    if (mat.set?.folder != null || direct) P.folder = mat.set?.folder || '';
    delete P.blob; delete P.trim; P.materialType = mat.set?.materialType || P.materialType;
    await db.put('videos', P);
    const partOf = Object.fromEntries(parts.map((p) => [p.media, p]));
    const fresh = mat.items.filter((it) => partOf[it.segments?.[0]?.media] && (it.text || it.ja) && !P.removedStudioItems?.includes(it.id)).map((it, order) => {
      const p = partOf[it.segments[0].media];
      const cue = studioCue(it, p.offset + it.segments[0].start, p.offset);
      if (it.role === 'example') cue.segments = it.segments.filter(g => partOf[g.media])
        .map(g => ({ start: partOf[g.media].offset + g.start, end: partOf[g.media].offset + g.end }));
      return { id: uid('c_'), videoId: P.id, part: p.videoId, ...(direct || mat.jaSpans ? { studioOrder: order } : {}), ...cue };
    });   // script order = timeline order
    if (update && oldParent) {
      const prev = await db.byIndex('cues', 'videoId', P.id); const used = new Set();
      for (const c of fresh) { const o = prev.find((x) => !used.has(x.id) && x.itemId === c.itemId); if (!o) continue; used.add(o.id); preserveCueEdits(c, o); }
      await protectedCues(P, prev, used, fresh);
    }
    await replaceCues(P.id, fresh);
    await transferJa(P, fresh);
    if (!direct && Array.isArray(mat.jaSpans)) await db.put('videos', P);
    first = P;
  }
  if (direct && first) {
    const completed = new Map(made.map(({ v }) => [v.id, v]));
    completed.set(first.id, first);
    await db.tx(['videos'], 'readwrite', tx => {
      for (const video of completed.values()) tx.objectStore('videos').put({ ...video, from: { ...video.from, importComplete: true } });
    });
  }
  if (missing.length) toast(`音声が入っていない部分（${missing.length}件）は取り込めませんでした。スタジオで音声を含めて書き出してください`, 5000);
  if (!missing.length) toast(`${nUpd ? `更新しました` : '取り込みました'}（字幕 ${mat.items.filter((it) => it.segments?.length && (it.text || it.ja)).length}行）`);
  return first;
}
// names for display: inner file paths / ids made by the pack are hidden (the saved name is not changed)
export function displayName(n) {
  const t = String(n || '').replace(/^(subtitles|media)\//, '').replace(/^tr_[a-z0-9]+-/i, '').replace(/^fp_[0-9a-f]+(_\d+)?/i, '').replace(/\.(srt|vtt|txt|csv|mp4|m4a|mov|mp3|wav)$/i, '').replace(/^[\s_-]+/, '').trim();
  return t || String(n || '無題');
}
// ---- 1.16: compress a stored sound (choose → convert → listen → replace). Cues keep their times; the original stays on failure ----
export async function compressVideoAudio(id) {
  const v = await db.get('videos', id); if (!v || v.kind === 'multi') return false;
  const blob = await videoBlob(v); if (!blob) { toast('音声ファイルがありません'); return false; }
  const { compressDialog, checkPlayable, TIERS } = await import('./compress.js');
  const lossy = !/wav/.test(v.mime || blob.type || '');
  const r = await compressDialog({ blob, name: displayName(v.name), duration: v.duration || 0, trackIndex: v.audioTrack ?? null, lossy, note: v.kind !== 'audio' && !/^audio/.test(v.mime || '') ? '動画は音声だけになります。' : '' });
  if (!r) return false;
  try {
    // write a test copy first: replace only when the saved copy reads back and plays
    await db.put('vblobs', { id: `${id}@new`, blob: r.file, size: r.file.size, at: Date.now() });
    const back = await db.get('vblobs', `${id}@new`);
    const ok = back?.blob && (await checkPlayable(back.blob, r.duration)).ok;
    await db.delete('vblobs', `${id}@new`);
    if (!ok) { toast('保存した圧縮音声を確認できなかったため、元のまま残しました', 4000); return false; }
    const old = blob.size;
    await putVideoBlob(id, r.file);   // the File from the conversion (never a blob read back from the database)
    const cur = await db.get('videos', id);
    Object.assign(cur, { mime: 'audio/mp4', size: r.file.size, compressed: { tier: r.tier, label: TIERS[r.tier].label, from: old, at: Date.now() }, audioChecked: true, audioFixed: true });
    delete cur.audioTrack; delete cur.audioInfo;
    await saveVideoMeta(cur);
    toast(`圧縮しました：${fmtSize(old)} → ${fmtSize(r.file.size)}`, 3000); return true;
  } catch (e) { toast('置き換えできませんでした（元のまま）：' + (e?.message || e), 4000); return false; }
}

// ---- media files live in their own store ('vblobs') and are written once ----
// (iPhone: putting a file that was read from the database back into it — e.g. with the play position — made it unreadable after reopening)
export async function videoBlob(v) { if (!v) return null; return (await db.get('vblobs', v.id))?.blob || (v.mediaRef ? (await db.get('vblobs', v.mediaRef))?.blob : null) || v.blob || null; }
async function putVideoBlob(id, blob) { await db.put('vblobs', { id, blob, size: blob.size, at: Date.now() }); }
// save the video record without its file (never puts a file read from the database back)
async function saveVideoMeta(rec) {
  const { blob, audioBlob, ...m } = rec;
  if (blob && !(await db.get('vblobs', rec.id))) m.blob = blob;   // older record not moved yet: left as it was
  await db.put('videos', m);
}
// older records: move the file into its own store once (only while it is still readable)
async function migrateBlob(v) {
  if (!v?.blob) return v;
  const { blob, audioBlob, ...m } = v;
  if (await db.get('vblobs', v.id)) { await db.put('videos', m); return m; }
  const { readable, copyBlob } = await import('./media-audio.js');
  if (!(await readable(blob))) return v;   // already unreadable: the "choose again" dialog handles it
  const fresh = await copyBlob(blob, () => {}, { name: v.name, type: v.mime || blob.type });
  await putVideoBlob(v.id, fresh); await db.put('videos', m); return m;
}
// lightweight video list without loading blobs into the page
async function videoMetas() {
  const files = new Set(await db.keys('vblobs'));
  const videos = await db.all('videos');
  const locations = new Map(videos.map(v => [v.id, v.mediaRef]));
  return videos.map(({ blob, ...m }) => ({ ...m, hasBlob: m.kind === 'multi' ? (m.parts || []).every((p) => (files.has(p.videoId) || files.has(locations.get(p.videoId)))) : !!blob || files.has(m.id) || files.has(m.mediaRef) })).sort((a, b) => b.createdAt - a.createdAt);
}
export async function videoNames() { return Object.fromEntries((await videoMetas()).map((v) => [v.id, v])); }

let cleanup = null;
function setCleanup(fn) { cleanup?.(); cleanup = fn; }
addEventListener('hashchange', () => { if (!location.hash.startsWith('#video-play')) setCleanup(null); });

// ================= List =================
export async function videoList(el) {
  setCleanup(null);
  const vids = await videoMetas();
  const cueCount = await db.countEach('cues', 'videoId', vids.map((v) => v.id));
  // children of a "parent" (several sound files joined): shown folded under it
  const kidIds = new Set(vids.filter((v) => v.kind === 'multi').flatMap((v) => (v.parts || []).map((p) => p.videoId)));
  const recent = (v) => v.playedAt || v.createdAt || 0;
  const tops = vids.filter((v) => !kidIds.has(v.id)).sort((a, b) => recent(b) - recent(a));
  const resume = vids.filter((v) => v.playedAt && v.lastTime > 1).sort((a, b) => b.playedAt - a.playedAt)[0];
  const T = (x) => (x ? fmtT(x).replace(/\.\d$/, '') : '');
  const rowHTML = (v, kid = false) => `
      <a class="card vrow ${kid ? 'vkid' : ''}" href="#video-play?id=${v.id}" data-id="${v.id}">
        <span class="vsel" hidden><input type="checkbox" data-pick="${v.id}"></span>
        <span class="vic2">${v.kind === 'multi' ? '📚' : String(v.mime || '').startsWith('audio') ? '🎧' : '🎬'}</span>
        <span class="grow vtxt"><b>${esc(displayName(v.name))}</b><span class="vmeta">${[v.kind === 'multi' ? `音声${(v.parts || []).length}本` : '', T(v.duration), `字幕${cueCount[v.id] || 0}行`, esc(L(v.lang || 'en').short)].filter(Boolean).join(' · ')}${v.hasBlob ? '' : ' · <span class="danger-text">ファイルなし</span>'}</span></span>
        <span class="muted">›</span>
      </a>`;
  const renderMaterial = v => {
    const kids = v.kind === 'multi' ? (v.parts || []).map(p => vids.find(x => x.id === p.videoId)).filter(Boolean) : [];
    return rowHTML(v) + (kids.length ? `<details class="vkids"><summary>音声ごと（${kids.length}）</summary>${kids.map(k => rowHTML(k, true)).join('')}</details>` : '');
  };
  const folders = new Map();
  for (const video of tops) {
    const key = video.folder || '';
    if (!folders.has(key)) folders.set(key, []);
    folders.get(key).push(video);
  }
  el.innerHTML = `
    <header class="top"><a href="#home" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>Video Lab</h1><span class="grow"></span><button class="icon-btn" id="vlMenu" aria-label="メニュー">⋯</button></header>
    ${resume ? `<a class="card vresume" href="#video-play?id=${resume.id}"><span class="grow"><span class="vmeta">続きから</span><b>${esc(displayName(resume.name))}</b><span class="vmeta">${T(resume.lastTime)} / ${T(resume.duration)}</span></span><span class="vresume-play">▶︎</span></a>` : ''}
    <div class="row vacts"><a class="btn sm primary grow" href="#studio/sets">🛠 教材を作る</a><label class="btn sm grow" for="vpack">📦 パックを読み込む</label></div>
    <input type="file" id="vpack" hidden><input type="file" id="vfile" accept="video/*" hidden>
    <div id="vlbar"></div>
    <div id="vl">${[...folders].map(([folder, materials]) => folder ?
      `<details class="card" open><summary>📁 ${esc(folder)}（${materials.length}）</summary>${materials.map(renderMaterial).join('')}</details>` :
      materials.map(renderMaterial).join('')).join('') || '<div class="card center muted">まだ教材がありません。「教材を作る」から作れます。</div>'}</div>`;
  // ⋯: less used things and the explanations
  $('#vlMenu', el).onclick = async () => {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>Video Lab</h3>
      <label class="btn" for="vfile" data-close>動画をそのまま追加（字幕ファイルがある場合など）</label>
      <a class="btn" href="#storage" data-close>容量の整理</a>
      <details class="card"><summary><b>使い方</b></summary><p class="small">取り込み・カット・文字起こし・字幕づくりは<b>教材スタジオ</b>で行い、ここでは再生と学習（速度・区間リピート・ディクテーション・シャドーイング・穴埋め）を行います。スタジオで教材を開き「⋯」→「英語ラボに送る」で入ります。<br>一覧の行は、タップで開く・長押しで名前の変更や削除・左スワイプで削除。</p></details>
      <details class="card"><summary><b>字幕・翻訳について（無料の範囲）</b></summary><p class="small">SRT/VTT字幕の読み込み・編集・再生・単語登録は追加料金なしです。日本語訳は再生画面の「⋯」→「日本語訳をClaudeに頼む」で依頼文をコピーし、Claudeのチャットで作れます。翻訳の全自動化（API）は使っていません。動画はこのiPhoneの中だけに保存され、外部には送りません。JSONバックアップに動画本体は含まれません（字幕は含まれます）。</p></details>
      <button class="btn ghost" value="cancel">閉じる</button></form>`;
    dlg.querySelectorAll('[data-close]').forEach((x) => x.addEventListener('click', () => setTimeout(() => dlg.close(), 0)));
    dlg.returnValue = ''; dlg.showModal();
  };
  // long press on a row: rename / delete
  let lpT = null, lpUsed = false;
  $('#vl', el).addEventListener('pointerdown', (e) => {
    const a = e.target.closest('.vrow'); if (!a) return; lpUsed = false; clearTimeout(lpT);
    lpT = setTimeout(async () => {
      lpUsed = true; try { navigator.vibrate?.(10); } catch {}
      const v = vids.find((x) => x.id === a.dataset.id); if (!v) return;
      const dlg = $('#dialog');
      dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(displayName(v.name))}</h3><button class="btn" value="rename">名前を変更</button>${v.kind === 'multi' ? '' : `<button class="btn" value="comp">音声を圧縮${v.compressed ? `（${v.compressed.label}済み）` : ''}</button>`}<button class="btn danger" value="del">削除</button><button class="btn ghost" value="cancel">閉じる</button></form>`;
      dlg.returnValue = ''; dlg.showModal(); await new Promise((q) => (dlg.onclose = q));
      if (dlg.returnValue === 'rename') { await new Promise((r) => setTimeout(r, 60)); const name = prompt('教材の名前', displayName(v.name)); if (name?.trim()) { const cur = await db.get('videos', v.id); cur.name = name.trim(); await saveVideoMeta(cur); videoList(el); } }
      if (dlg.returnValue === 'del') { await new Promise((r) => setTimeout(r, 60)); if (await removeVideos([v.id])) videoList(el); }
      if (dlg.returnValue === 'comp') { await new Promise((r) => setTimeout(r, 60)); if (await compressVideoAudio(v.id)) videoList(el); }
    }, 550);
  });
  const lpEnd = () => clearTimeout(lpT);
  $('#vl', el).addEventListener('pointerup', lpEnd); $('#vl', el).addEventListener('pointercancel', lpEnd); $('#vl', el).addEventListener('pointermove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) lpEnd(); });
  $('#vl', el).addEventListener('click', (e) => { if (lpUsed && e.target.closest('.vrow')) { e.preventDefault(); e.stopPropagation(); lpUsed = false; } }, true);
  $('#vl', el).addEventListener('contextmenu', (e) => { if (e.target.closest('.vrow')) e.preventDefault(); });
  // delete: swipe a row to the left, or 選ぶ → すべて選ぶ / 削除
  let picking = false; const picked = new Set();
  const drawBar = () => {
    const bar = $('#vlbar', el); if (!vids.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = picking
      ? `<div class="row" style="margin:10px 0 6px"><button class="btn sm" id="vAll">${picked.size === vids.length ? 'すべて外す' : 'すべて選ぶ'}</button><button class="btn sm danger" id="vDel" ${picked.size ? '' : 'disabled'}>削除（${picked.size}）</button><span class="grow"></span><button class="btn sm" id="vDone">完了</button></div>`
      : `<div class="row" style="margin:14px 0 4px"><span class="grow vsec">教材 <span class="muted">${vids.length}</span></span><button class="btn sm ghost" id="vPick">選ぶ</button></div>`;
    $('#vPick', bar)?.addEventListener('click', () => { picking = true; drawRows(); });
    $('#vDone', bar)?.addEventListener('click', () => { picking = false; picked.clear(); drawRows(); });
    $('#vAll', bar)?.addEventListener('click', () => { if (picked.size === vids.length) picked.clear(); else vids.forEach((v) => picked.add(v.id)); drawRows(); });
    $('#vDel', bar)?.addEventListener('click', async () => { if (await removeVideos([...picked])) videoList(el); });
  };
  const drawRows = () => {
    $$('#vl .vrow', el).forEach((a) => { a.querySelector('.vsel').hidden = !picking; const cb = a.querySelector('[data-pick]'); cb.checked = picked.has(a.dataset.id); });
    drawBar();
  };
  async function removeVideos(ids) {
    if (!ids.length) return false;
    const names = vids.filter((v) => ids.includes(v.id)).map((v) => v.name);
    if (!(await confirmDialog({ title: `${ids.length}件を削除`, body: `<p>${names.slice(0, 8).map(esc).join('<br>')}${names.length > 8 ? `<br>ほか${names.length - 8}件` : ''}</p><p class="hint">動画・音声と字幕・穴埋めを消します（元に戻せません）。この動画から登録した単語は残ります。</p>`, okLabel: '削除', danger: true }))) return false;
    const cues = (await Promise.all(ids.map((id) => db.byIndex('cues', 'videoId', id)))).flat();
    const mediaKeys = await releaseVideoMedia(ids);   // the studio's sets that use these sounds keep their own copy
    await db.tx(['videos', 'vblobs', 'cues', 'videoJa'], 'readwrite', (t) => { for (const id of ids) { removeVideoJaInTx(t, id); t.objectStore('videos').delete(id); } for (const key of mediaKeys) t.objectStore('vblobs').delete(key); cues.forEach((c) => t.objectStore('cues').delete(c.id)); });
    toast(`${ids.length}件を削除しました`); return true;
  }
  $('#vl', el).addEventListener('click', (e) => {
    if (!picking) return;
    const a = e.target.closest('.vrow'); if (!a) return;
    e.preventDefault(); const id = a.dataset.id; picked.has(id) ? picked.delete(id) : picked.add(id); drawRows();
  });
  swipeToDelete($$('#vl .vrow', el), async (row) => { if (picking) return false; const ok = await removeVideos([row.dataset.id]); if (ok) videoList(el); return ok; });
  drawBar();
  // material pack from the studio: its sound/video + subtitles (EN/JA) + hidden words become a video lab entry
  $('#vpack', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const { zipRead } = await import('./common-pack.js'); const { copyBlob } = await import('./media-audio.js');
      const z = await zipRead(f);
      const manifest = JSON.parse(await z.text('manifest.json')), mat = JSON.parse(await z.text('material.json'));
      if (manifest.format !== 'elpack') throw new Error('教材スタジオのパックではありません');
      const first = await importMaterial(manifest, mat, async (m) => (m.included ? z.file(m.path) : null));
      if (first) go(`#video-play?id=${first.id}`);
    } catch (err) { toast('取り込めませんでした：' + (err?.message || err), 5000); }
  };
  $('#vfile', el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 500 * 1048576 && !(await confirmDialog({ title: '大きな動画です', body: `<p>${fmtSize(f.size)}あります。保存に時間がかかり、iPhoneの空き容量を使います。続けますか？</p>`, okLabel: '保存する' }))) return;
    toast('保存中…', 10000);
    try {
      const duration = await probeDuration(f);
      // a real copy (Safari may otherwise keep only a reference to a temporary file that iOS deletes later)
      // a real copy; for screen recordings (app sound + microphone) only the speech track is kept in the saved video
      const { saveVideoCopy } = await import('./media-audio.js');
      const sv = f.size <= 600 * 1048576 ? await saveVideoCopy(f, { onStep: (m) => toast(m, 10000) }) : { blob: f, info: null };
      const blob = sv.blob;
      const v = { id: uid('v_'), lang: curLang(), name: f.name.replace(/\.[^.]+$/, '') || '動画', mime: f.type || 'video/mp4', size: blob.size, duration, lastTime: 0, createdAt: Date.now(), audioChecked: true, audioFixed: true };
      if (sv.info) v.audioInfo = sv.info; if (sv.trackIndex != null) v.audioTrack = sv.trackIndex;
      await putVideoBlob(v.id, blob); await saveVideoMeta(v);
      toast('動画を追加しました。字幕はファイルで読み込むか、教材スタジオで作ってください', 3500);
      go(`#video-play?id=${v.id}`);
    } catch (err) { toast('保存できませんでした: ' + (err?.message || err)); }
  };
}
function probeDuration(file) {
  return new Promise((res) => {
    const v = document.createElement('video'); const url = URL.createObjectURL(file);
    v.preload = 'metadata'; v.muted = true; v.src = url;
    v.onloadedmetadata = () => { res(isFinite(v.duration) ? v.duration : 0); URL.revokeObjectURL(url); };
    v.onerror = () => { res(0); URL.revokeObjectURL(url); };
    setTimeout(() => res(0), 8000);
  });
}

// ================= Player =================
const SPEEDS = [0.75, 0.9, 1, 1.25, 1.5];
const VIEW_DEFAULTS = { mode: 'both', order: 'en', primary: 'en', opEn: 1, opJa: 1, fsEn: 19, fsJa: 15, step: false, test: false, cloze: false, clozeUnit: 'phrase', clozeAuto: false, jaHint: true, loopMax: 0 };
const OPS = [1, 0.7, 0.4, 0.2], FS_EN = [[15, '小'], [19, '中'], [23, '大'], [28, '特大']], FS_JA = [[12, '小'], [15, '中'], [18, '大'], [22, '特大']];
const MODES = [['both', '英＋日'], ['en', '英語のみ'], ['ja', '日本語のみ'], ['none', '字幕なし']];
async function loadView() {
  const v = await getSetting('video.view', null);
  if (v) return { ...VIEW_DEFAULTS, ...v };
  // from the older separate settings
  const en = await getSetting('video.en', true), ja = await getSetting('video.ja', true), step = await getSetting('video.step', false);
  return { ...VIEW_DEFAULTS, mode: en && ja ? 'both' : en ? 'en' : ja ? 'ja' : 'none', step };
}

// several files played as one timeline: looks like a <video> to the player (currentTime / duration / play / pause / events)
function multiMedia(el, parts) {
  let cur = 0, pendingSeek = null, rate = 1, endFns = [];
  const total = parts.reduce((a, p) => Math.max(a, p.offset + p.dur), 0);
  const partAt = (t) => { for (let i = parts.length - 1; i >= 0; i--) if (t >= parts[i].offset - 0.001) return i; return 0; };
  const go = (i, local, play) => {
    cur = i; pendingSeek = local; el.src = parts[i].url;
    el.playbackRate = rate;
    if (play) { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} el.play().catch(() => {}); }
  };
  el.addEventListener('loadedmetadata', () => { el.playbackRate = rate; if (pendingSeek != null) { try { el.currentTime = pendingSeek; } catch {} pendingSeek = null; } });
  el.addEventListener('ended', () => { if (cur < parts.length - 1) go(cur + 1, 0, true); else endFns.forEach((f) => f()); });
  const api = {
    get currentTime() { return parts[cur].offset + (pendingSeek ?? el.currentTime ?? 0); },
    set currentTime(t) { t = Math.max(0, Math.min(total, t)); const i = partAt(t), local = Math.max(0, t - parts[i].offset); if (i === cur && pendingSeek == null) el.currentTime = local; else if (i === cur) pendingSeek = local; else go(i, local, !el.paused); },
    get duration() { return total; },
    get paused() { return el.paused; },
    get seeking() { return el.seeking || pendingSeek != null; },
    get readyState() { return el.readyState; },
    get videoWidth() { return el.videoWidth; },
    get audioTracks() { return el.audioTracks; },
    get audioTrack() { return parts[cur].audioTrack; },
    get playbackRate() { return rate; },
    set playbackRate(r) { rate = r; el.playbackRate = r; },
    play() { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} return el.play(); },
    pause() { el.pause(); },
    addEventListener(type, fn, opt) { if (type === 'ended') endFns.push(fn); else el.addEventListener(type, fn, opt); },
    removeEventListener(type, fn, opt) { if (type === 'ended') endFns = endFns.filter((f) => f !== fn); else el.removeEventListener(type, fn, opt); },
    get el() { return el; },
  };
  return api;
}
export async function videoPlay(el, params) {
  setCleanup(null);
  let v = await db.get('videos', params.get('id'));
  if (v) v = await migrateBlob(v);
  // one entry made of several sound files (a script and its audio pieces): one timeline over all parts
  let parts = null, missingPart = false;
  if (v?.kind === 'multi') {
    parts = [];
    for (const p of v.parts || []) {
      const child = await db.get('videos', p.videoId), b = await videoBlob(child);
      if (!b) { missingPart = true; continue; }
      parts.push({ ...p, url: URL.createObjectURL(b), blob: b, audioTrack: child.audioTrack });
    }
  }
  const fileBlob = parts ? parts[0]?.blob || null : await videoBlob(v);
  if (!v) { el.innerHTML = `<header class="top"><a href="#video" class="back" aria-label="戻る">${icon('back', 24)}</a><h1>動画が見つかりません</h1></header><div class="card muted">削除された可能性があります。</div>`; return; }
  const vlang = v.lang || 'en';
  const TL = L(vlang).name;
  let cues = await cuesOf(v.id);
  let jaRecords = await readVideoJa(v.id), jaView = videoJaView(cues, jaRecords);
  const jaFor = cue => jaView.get(cue);
  const refreshJa = async () => {
    jaRecords = await readVideoJa(v.id);
    jaView = videoJaView(cues, jaRecords);
    $('#reviewJa', el).hidden = !jaView.review.length;
    $('#clearJa', el).hidden = !jaRecords.some(row => row.refs?.length) && !cues.some(c => jaFor(c) || jaView.needsReview(c));
    drawList(); drawSub();
  };
  const scriptOrder = () => cues.some(c => c.studioOrder != null) ? cues.slice().sort(
    (a, b) => (a.studioOrder ?? Infinity) - (b.studioOrder ?? Infinity) || compareVideoCues(a,b)) : cues;
  const view = await loadView();
  const saveView = () => setSetting('video.view', view);
  let singleSegment = null, loop = null, ab = null, curId = null, rafId = 0, saveT = 0, seekT = 0, loopN = 0, stepCue = null, revealedCue = null, editing = false;
  const revealed = new Map();   // cueId -> Set(hole index)
  const url = parts ? parts[0]?.url || '' : fileBlob ? URL.createObjectURL(fileBlob) : '';
  const aurl = '';   // (1.3.1–1.3.2 used a separate sound file; now the chosen track of the video itself is played)
  const MLABEL = (m) => MODES.find((x) => x[0] === m)[1].replace('英', L(vlang).ch);

  el.innerHTML = `
    <div class="vp-root v112 v114" id="vroot">
    <header class="top"><a href="#video" class="back" aria-label="戻る">${icon('back', 24)}</a><h1 class="vtitle">${esc(v.name)}</h1><span class="grow"></span><button class="icon-btn vh-btn vmode-btn" id="openMode" aria-label="学習モード">🎛</button><button class="icon-btn vh-btn" id="openSet" aria-label="表示・学習の設定">⚙︎</button><button class="icon-btn vh-btn" id="openMake" aria-label="字幕・日本語訳">字</button><button class="icon-btn" id="menu" aria-label="メニュー">⋯</button></header>
    <div class="vwrap">${!url ? '<div class="card warn">動画ファイルがありません（バックアップから復元した場合は、動画をもう一度追加してください）</div>'
      : aurl ? `<video id="vpic" src="${url}" muted playsinline webkit-playsinline preload="metadata"></video><audio id="vid" src="${aurl}" preload="auto" playsinline></audio>`
      : `<video id="vid" src="${url}" playsinline webkit-playsinline preload="metadata"></video><div class="vov vh-aux"><button class="vov-b" id="vAir" aria-label="AirPlay" hidden>▭</button><button class="vov-b" id="vFull" aria-label="全画面">⛶</button></div>`}</div>
    <div class="vbottom"><div class="vbin">
      <!-- 1.15: buttons, then one seek bar at the bottom (shared by video and sound) -->
      <div class="vctl2b">
        <div class="vb-side"><button class="vb vb-speed" id="speed" aria-label="速さ">1×</button><button class="vb vb-speed vb-loop" id="loopBtn" aria-label="この文をループ">🔁</button></div>
        <button class="vb vb-skip" id="prevCue" aria-label="この文の頭へ・前の文">⏮</button>
        <button class="vb vb-step" id="back" aria-label="戻す（長押しで秒数）">⟲3</button>
        <button class="vb vb-play" id="play" aria-label="再生">▶︎</button>
        <button class="vb vb-step" id="fwd" aria-label="送る（長押しで秒数）">3⟳</button>
        <button class="vb vb-skip" id="nextCue" aria-label="次の文">⏭</button>
      </div>
      <div class="vseek" id="seek"><div class="vs-track"><i class="vs-range" id="sRange"></i><i class="vs-played" id="sPlayed"></i><i class="vs-head" id="sHead"></i></div></div>
      <div class="vs-info small"><span id="sTime">0:00.0</span><span id="sRangeTxt" class="grow center"></span><button class="link small" id="sClear" hidden>区間を解除</button><button class="link small vs-ab" id="sAB">⟲ 区間リピート</button></div>
    </div></div>
    <div class="subbox" id="sub"></div>
    <div id="grade"></div>
    <div class="vsheet" id="shMode" hidden><div class="vsheet-in card stack"><div class="row between"><b>学習モード</b><button class="btn sm" data-shclose>閉じる</button></div>
    <div class="vquick vquick-sheet">
      <button class="tgl" id="qMode"></button>
      <button class="tgl" id="qDict">ディクテーション</button>
      <button class="tgl" id="qShadow">シャドーイング</button>
      <button class="tgl" id="qRange">字幕で区間指定</button>
      <button class="tgl" id="qCloze">穴埋め</button>
      <button class="tgl" id="qLoop">ループ</button>
      <button class="tgl" id="qTest">字幕なしテスト</button>
    </div></div></div>
    <div id="dict" class="card stack dict" hidden></div>
    <div id="shadow" class="card stack" hidden></div>
    <div class="vsheet" id="shSet" hidden><div class="vsheet-in card stack"><div class="row between"><b>表示・学習の設定</b><button class="btn sm" data-shclose>閉じる</button></div><div class="vset stack" id="set">
      <div class="fgrp"><span>主字幕</span><div class="seg" id="primary"><button data-v="en">${esc(TL)}</button><button data-v="ja">日本語</button></div></div>
      <div class="fgrp"><span>2言語のとき</span><div class="seg" id="order"><button data-v="en">${esc(L(vlang).ch)}が上</button><button data-v="ja">日本語が上</button></div></div>
      <div class="fgrp"><span>${esc(TL)}の透明度</span><div class="seg" id="opEn">${OPS.map((o) => `<button data-v="${o}">${o * 100}%</button>`).join('')}</div></div>
      <div class="fgrp"><span>${esc(TL)}の文字</span><div class="seg" id="fsEn">${FS_EN.map(([n, l]) => `<button data-v="${n}">${l}</button>`).join('')}</div></div>
      <div class="fgrp"><span>日本語の透明度</span><div class="seg" id="opJa">${OPS.map((o) => `<button data-v="${o}">${o * 100}%</button>`).join('')}</div></div>
      <div class="fgrp"><span>日本語の文字</span><div class="seg" id="fsJa">${FS_JA.map(([n, l]) => `<button data-v="${n}">${l}</button>`).join('')}</div></div>
      <label class="chk"><input type="checkbox" id="step"> 1文ごとに一時停止</label>
      <div class="fgrp"><span>ループ</span><div class="seg" id="loopMax"><button data-v="0">ずっと</button><button data-v="3">3回で次の文へ</button></div></div>
      <button class="btn sm" id="tAB">A-B区間リピート</button>
      <h3 class="sub">穴埋め</h3>
      <div class="fgrp"><span>隠す単位</span><div class="seg" id="clozeUnit"><button data-v="word">単語</button><button data-v="phrase">熟語（続けて選ぶとまとまる）</button></div></div>
      <div class="fgrp"><span>穴の選び方</span><div class="seg" id="clozeAuto"><button data-v="0">手動</button><button data-v="1">自動の候補を使う</button></div></div>
      <label class="chk"><input type="checkbox" id="jaHint"> 日本語訳をヒントとして表示（字幕モードに関係なく）</label>
      <div class="row"><button class="btn sm grow" id="edit">穴を選ぶ（語をタップ）</button><button class="btn sm grow" id="autoGo">自動の候補で穴を作る</button></div>
      <div id="czStats" class="small"></div>
    </div></div></div>
    <div class="vsheet" id="shMake" hidden><div class="vsheet-in card stack"><div class="row between"><b>字幕・日本語訳</b><button class="btn sm" data-shclose>閉じる</button></div><div id="make">
      <div class="stack">
        <p class="hint">字幕の自動作成・前後のカット・スクリプト合わせは<b>教材スタジオ</b>で行います（ここは再生と学習用）。日本語訳は英文と訳文のJSONから追加できます。章番号が分かる場合は chapter を指定できます。</p>
        <button class="btn" id="exportJa" ${cues.some(c => c.en) ? '' : 'disabled'}>翻訳用の字幕情報を書き出す（JSON）</button>
        <button class="btn" id="clearJa" ${jaRecords.some(row => row.refs?.length) || cues.some(c => jaFor(c) || jaView.needsReview(c)) ? '' : 'hidden'}>日本語訳だけ削除</button>
        <button class="btn" id="reviewJa" ${jaView.review.length ? '' : 'hidden'}>日本語訳の要確認を表示</button>
        <button class="btn" id="askClaude" ${cues.some((c) => c.en) ? '' : 'disabled'}>翻訳依頼文をコピー</button>
        <button class="btn" data-paste="ja">返ってきた日本語訳を貼り付け</button>
        <label class="btn" for="fEn">${esc(TL)}字幕ファイル（SRT/VTT）を読み込む</label>
        <label class="btn" for="fJa">日本語訳を読み込む（英文照合・字幕ID）</label>
        <button class="btn" data-paste="en">${esc(TL)}字幕を貼り付け</button>
      </div></div></div></div>
    <p class="small muted center" id="modeTxt"></p>
    <div class="row between"><h2 class="sec" style="margin:14px 4px 6px">字幕 <span class="muted small">${cues.length}行</span></h2><button class="link small" id="addCue">＋ 現在位置に追加</button></div>
    <div class="cuelist" id="cl"></div>
    <input type="file" id="fEn" hidden><input type="file" id="fJa" hidden>
    </div>`;

  const root = $('#vroot', el), sub = $('#sub', el), cl = $('#cl', el);
  // subtitle list follows the sound, gently; when you scroll it yourself (to read a line that has passed) it stops following
  // until you tap 「現在の行へ」 or a line, or leave it for 20 seconds
  let followOff = 0;
  const followBtn = document.createElement('button'); followBtn.className = 'btn sm vfollow'; followBtn.textContent = '↧ 現在の行へ'; followBtn.hidden = true;
  cl?.before(followBtn);
  // the subtitle list fills the space down to the control panel (whose height changed in 1.12)
  const vbar = $('.vbottom', el);
  const fitList = () => { if (!cl || !vbar) return; const top = cl.getBoundingClientRect().top + scrollY; cl.style.maxHeight = `${Math.max(140, innerHeight - vbar.offsetHeight - top - 8)}px`; };
  const fitRO = new ResizeObserver(() => fitList()); if (vbar) fitRO.observe(vbar); if (sub) fitRO.observe(sub); const vmedia = $('video, audio', el); if (vmedia) fitRO.observe(vmedia); addEventListener('resize', fitList);
  const followCue = (row, force = false) => {
    if (!cl || !row) return;
    if (!force && followOff && Date.now() - followOff < 20000) { followBtn.hidden = false; return; }
    followOff = 0; followBtn.hidden = true;
    const top = row.offsetTop - cl.offsetTop, y = top - cl.scrollTop, h = cl.clientHeight;
    if (force || y < h * 0.12 || y + row.offsetHeight > h * 0.75) cl.scrollTo({ top: Math.max(0, top - h * 0.25), behavior: 'smooth' });
  };
  if (cl) {
    const off = () => { followOff = Date.now(); };
    cl.addEventListener('touchmove', off, { passive: true }); cl.addEventListener('wheel', off, { passive: true });
    cl.addEventListener('click', () => { followOff = 0; followBtn.hidden = true; });
    followBtn.onclick = () => { followOff = 0; followCue(cl.querySelector('.cue.cur'), true); };
  }
  const vid = parts && $('#vid', el) ? multiMedia($('#vid', el), parts) : $('#vid', el);
  // while typing (dictation) the keyboard is up: hide the bottom buttons so they do not cover the input
  root?.addEventListener('focusin', (e) => { if (e.target.matches('textarea, input[type=text], input:not([type])')) document.body.classList.add('vtyping'); });
  root?.addEventListener('focusout', () => setTimeout(() => { if (!root.contains(document.activeElement) || !document.activeElement.matches('textarea, input')) document.body.classList.remove('vtyping'); }, 50));
  if (missingPart) toast('この教材の音声の一部が見つかりません（元の音声の教材が削除された可能性）', 5000);
  // every play: ask iOS for the "playback" sound session inside the tap (it can drop back after the app is reopened → no sound)
  if (vid) { const _play = vid.play.bind(vid); vid.play = () => { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} return _play(); }; }
  // sound only: a slim bar instead of a black video area
  const markAudio = () => {
    if (!vid || !(parts || String(v.mime || '').startsWith('audio') || (vid.readyState >= 1 && !vid.videoWidth))) return;
    $('.vwrap', el)?.classList.add('audio');
    const t = $('.vtitle', el); if (t && !t.dataset.audio) { t.dataset.audio = '1'; t.textContent = '🎧 ' + t.textContent; }
  };
  vid?.addEventListener('loadedmetadata', markAudio); markAudio();
  // 1.15: tap the video to show / hide the extra buttons (back and ⋯ always stay)
  const vroot = $('#vroot', el), vEl = $('video#vid', el);
  $('.vwrap', el)?.addEventListener('click', (e) => { if (e.target.closest('.vov-b')) return; vroot.classList.toggle('hideaux'); });
  if (vEl) {
    $('#vFull', el).onclick = () => { try { vEl.webkitEnterFullscreen ? vEl.webkitEnterFullscreen() : vEl.requestFullscreen?.(); } catch {} };
    if (window.WebKitPlaybackTargetAvailabilityEvent && vEl.webkitShowPlaybackTargetPicker) { const ab2 = $('#vAir', el); ab2.hidden = false; ab2.onclick = () => { try { vEl.webkitShowPlaybackTargetPicker(); } catch {} }; }
  }
  // settings / subtitles open as sheets (hidden by default)
  const sheet = (id, on) => { const x = $(id, el); if (x) x.hidden = !on; };
  $('#openSet', el).onclick = () => sheet('#shSet', true);
  $('#openMake', el).onclick = () => sheet('#shMake', true);
  // 学習モード: one button → a sheet with the modes; the chosen ones are listed next to the button
  // the header button shows a dot while a mode (dictation, shadowing …) is on
  const modeOn = () => { const on = $$('#shMode .tgl.on', el).filter((b) => b.id !== 'qMode').map((b) => b.textContent.trim()); const m = $('#openMode', el); if (m) { m.classList.toggle('on', on.length > 0); m.title = on.join('・'); } };
  $('#openMode', el).onclick = () => sheet('#shMode', true);
  $('#shMode', el).addEventListener('click', (e) => { const b = e.target.closest('.tgl'); if (!b) return; setTimeout(() => { modeOn(); if (b.id !== 'qMode') sheet('#shMode', false); }, 0); });
  setTimeout(modeOn, 0); setTimeout(modeOn, 500);
  $$('.vsheet', el).forEach((x) => x.addEventListener('click', (e) => { if (e.target === x || e.target.closest('[data-shclose]')) x.hidden = true; }));
  const pic = null;
  if (v.audioBlob) { (async () => { const cur = await db.get('videos', v.id); if (cur?.audioBlob) await saveVideoMeta(cur); })(); }   // free the old separate sound file
  // videos saved before: decide the speech track once — only while paused (Web Audio during playback can stop the sound on iPhone)
  if (vid && fileBlob && !v.audioFixed) {
    const check = async () => {
      if (!vid.paused) return setTimeout(check, 3000);
      try {
        const { speechTrackIndex, readable } = await import('./media-audio.js');
        if (!(await readable(fileBlob))) return;
        const fname = v.name + ((v.mime || '').includes('quicktime') ? '.mov' : '.mp4');
        const sp = await speechTrackIndex(fileBlob, fname);
        const cur = await db.get('videos', v.id); if (!cur) return;
        cur.audioChecked = true; cur.audioFixed = true;
        if (sp) {
          const { keepOneAudioTrack } = await import('./media-probe.js');
          toast('音声を直しています（話し声の方だけ残します）…', 8000);
          const f2 = await keepOneAudioTrack(fileBlob, sp.id, { name: fname, type: v.mime || 'video/mp4' }).catch(() => null);
          if (f2) { const { copyBlob } = await import('./media-audio.js'); await putVideoBlob(v.id, await copyBlob(f2, () => {}, { name: fname, type: v.mime || 'video/mp4' })); cur.size = f2.size; delete cur.audioTrack; cur.audioInfo = { count: sp.count, kept: sp.index, reason: sp.reason, auto: sp.auto }; }
          else { cur.audioTrack = sp.index; }
        }
        await saveVideoMeta(cur);
        if (sp && location.hash.includes(v.id)) { toast(`音声が${sp.count}本あったので、話し声の方（音声${sp.index + 1}）だけにしました`, 3500); videoPlay(el, params); }
      } catch {}
    };
    setTimeout(check, 500);
  }
  if (vid && !pic) {
    // several sound tracks (screen recordings: app sound + microphone): play only the one with speech, never mix
    vid.addEventListener('loadedmetadata', enableTrack);
    vid.addEventListener('error', async () => {
      const { readable } = await import('./media-audio.js');
      if (!(await readable(fileBlob)) && (await confirmDialog({ title: '動画データが読めません', body: '<p>保存していた動画データが読めなくなっています（iPhoneが一時ファイルを消した可能性）。字幕・穴埋め・学習記録はそのまま残っています。</p>', okLabel: '動画を選び直す', cancelLabel: '閉じる' }))) relinkVideo();
    });
  }
  // ---- trimming (non-destructive): playback and transcription stay inside [trim.start, trim.end] ----
  function enableTrack() {
    const at = vid?.audioTracks, track = parts ? vid.audioTrack : v.audioTrack;
    if (!at || at.length < 2 || track == null) return;
    for (let i = 0; i < at.length; i++) at[i].enabled = i === track;
  }
  {   // speech recognition quality (tap to choose)
    const QT = { fast: '速さ：約40MB・速いが聞き間違いが多い', acc: '標準：約80MB・おすすめ', best: '最高：約250MB・2〜3倍遅い・試験的（iPhoneのメモリによっては止まる）' };
    const drawQ = (q) => { $$('#asrQ button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === q)); $('#asrQtxt', el).textContent = QT[q]; };
    if ($('#asrQ', el)) getSetting('video.asrQ', 'acc').then(drawQ);
    if ($('#asrQ', el)) $('#asrQ', el).onclick = async (e) => { const q = e.target.closest('button')?.dataset.v; if (!q) return; await setSetting('video.asrQ', q); drawQ(q); };
  }
  const showEn = () => view.mode === 'both' || view.mode === 'en';
  const showJa = () => view.mode === 'both' || view.mode === 'ja' || (view.cloze && view.jaHint);

  // ---- appearance (CSS variables / classes only: never touches playback) ----
  function applyView() {
    root.style.setProperty('--fsEn', view.fsEn + 'px'); root.style.setProperty('--fsJa', view.fsJa + 'px');
    root.style.setProperty('--opEn', view.opEn); root.style.setProperty('--opJa', view.opJa);
    root.classList.toggle('jatop', view.order === 'ja');
    root.dataset.primary = view.primary;
    root.dataset.mode = view.mode;   // the subtitle box keeps one height per mode (the screen below does not jump)
    if (sub) requestAnimationFrame(fitSub);
    const segOn = (id, val) => $$(`#${id} button`, el).forEach((b) => b.classList.toggle('on', String(b.dataset.v) === String(val)));
    segOn('order', view.order); segOn('primary', view.primary); segOn('opEn', view.opEn); segOn('opJa', view.opJa); segOn('fsEn', view.fsEn); segOn('fsJa', view.fsJa);
    segOn('loopMax', view.loopMax); segOn('clozeUnit', view.clozeUnit); segOn('clozeAuto', view.clozeAuto ? 1 : 0);
    $('#step', el).checked = view.step; $('#jaHint', el).checked = view.jaHint;
    $('#qMode', el).textContent = `字幕：${MLABEL(view.mode)}`;
    $('#qCloze', el).classList.toggle('on', view.cloze);
    $('#loopBtn', el)?.classList.toggle('on', !!loop);
    $('#qLoop', el).classList.toggle('on', !!loop); $('#qLoop', el).textContent = !loop ? 'ループ' : view.loopMax ? `ループ${view.loopMax}回` : 'ループ∞';
    $('#qTest', el).classList.toggle('on', view.test);
    $('#qDict', el).classList.toggle('on', dictOn); $('#qShadow', el).classList.toggle('on', shadowOn); $('#qRange', el).classList.toggle('on', !!rangeMode);
    $('#tAB', el).classList.toggle('on', !!ab); drawSeek?.(); $('#tAB', el).textContent = !ab ? 'A-B区間リピート' : ab.b == null ? 'B地点を押す' : `A-B ${fmtT(ab.a)}–${fmtT(ab.b)}（押すと解除）`;
    $('#edit', el).classList.toggle('on', editing); $('#edit', el).textContent = editing ? '穴を選び終える' : '穴を選ぶ（語をタップ）';
    $('#autoGo', el).hidden = !view.clozeAuto;
    $('#modeTxt', el).textContent = [view.test ? '聞き取りテスト中：字幕はタップで表示' : '', view.cloze ? '穴埋め：_____ をタップで答え' : '', editing ? '穴を選ぶ：字幕の語をタップ' : '', view.step && !view.test ? '1文ごとに停止' : ''].filter(Boolean).join('・');
    drawSub(); drawList();
  }
  const textHTML = (c, where) => {
    const en = c.en ? (view.cloze || editing ? clozeHTML(c.en, c.holes || [], { lang: vlang, revealed: revealed.get(c.id) || new Set(), editing, cueId: c.id }) : esc(c.en)) : '';
    const veil = where === 'sub' && view.test && revealedCue !== c.id ? ' veil' : '';
    const parts = [];
    if (showEn() && c.en) parts.push(`<div class="sen${veil}" ${langAttr(vlang)}>${en}</div>`);
    const ja = jaFor(c);
    if (showJa() && ja) parts.push(`<div class="sja${veil}">${esc(ja)}</div>`);
    if (where === 'list' && jaView.needsReview(c)) parts.push('<small class="warn-text">日本語訳 要確認</small>');
    return parts.join('');
  };
  function drawSub() {
    const c = cues.find((x) => x.id === curId);
    sub.innerHTML = c ? textHTML(c, 'sub') + (view.test && revealedCue !== c.id ? '<span class="subhint">タップで字幕を表示</span>' : '') : '';
    sub.classList.toggle('empty', !sub.innerHTML);
    fitSub();
  }
  // the box keeps its height; a long sentence gets smaller letters instead of scrolling
  function fitSub() {
    let f = 1; sub.style.setProperty('--fit', 1);
    while (sub.scrollHeight > sub.clientHeight + 1 && f > 0.55) { f -= 0.07; sub.style.setProperty('--fit', f.toFixed(2)); }
  }
  function drawList() {
    if (!cues.length) { cl.innerHTML = `<div class="card stack"><p class="small muted">字幕がまだありません。上の「字幕を作る・読み込む」から作成・読み込みできます。</p></div>`; return; }
    cl.innerHTML = scriptOrder().map((c) => `
      <div class="cue ${c.id === curId ? 'cur' : ''}" data-id="${c.id}">
        <span class="ct">${fmtT(c.start)}</span>
        <span class="grow ctext ${view.test && !rangeMode ? 'veil' : ''}">${rangeMode && c.en ? `<div class="sen" ${langAttr(vlang)}>${toks(c).map((k, i) => `<span class="rk" data-rk="${c.id}:${i}">${esc(k.w)}</span>`).join(' ')}</div>` : textHTML(c, 'list') || '<span class="muted small">（非表示）</span>'}</span>
        ${c.en ? `<button class="cbtn" data-word="${c.id}" aria-label="単語登録">＋語</button>` : ''}
        ${(c.role === 'example' ? c.segments || [] : []).slice(1).map((g, i) => `<button class="cbtn" data-repeat="${i+1}">復唱 ${i+1}</button>`).join('')}
        ${c.en ? `<button class="cbtn" data-ja="${c.id}" aria-label="日本語訳を編集">訳</button>` : ''}
        <button class="cbtn" data-edit="${c.id}" aria-label="編集">✎</button>
      </div>`).join('');
  }
  function drawStats() {
    const holes = cues.flatMap((c) => (c.holes || []).map((h, i) => ({ c, h, i })));
    const ok = holes.filter((x) => x.h.last === 'ok').length, ng = holes.filter((x) => x.h.last === 'ng');
    $('#czStats', el).innerHTML = holes.length ? `穴 ${holes.length}個（聞けた ${ok}・聞けなかった ${ng.length}・未回答 ${holes.length - ok - ng.length}）
      ${ng.length ? `<div class="stack" style="margin-top:6px">${ng.map((x) => `<div class="row between"><span>「${esc(x.h.text)}」</span><button class="btn sm" data-addng="${x.c.id}:${x.i}">単語帳に追加</button></div>`).join('')}</div>` : ''}` : '<span class="muted">まだ穴がありません</span>';
  }

  function cueAt(t) { let r = null; for (const c of cues) { if (c.start > t) break; if ((c.role === 'example' && c.segments?.length ? c.segments : [c]).some(g => g.start <= t && t < g.end)) r = c; } return r; }
  function tick() {
    if (!vid) return;
    const t = vid.currentTime;
    if (loop && t >= loop.end) {
      loopN++;
      if (view.loopMax && loopN >= view.loopMax) {
        const nx = cues.find((x) => x.start >= loop.end - 0.01);
        if (nx) { loop = { start: nx.start, end: nx.end }; loopN = 0; vid.currentTime = nx.start; } else { loop = null; vid.pause(); applyView(); }
      } else vid.currentTime = loop.start;
    }
    if (ab?.b != null && t >= ab.b) vid.currentTime = ab.a;
    if (shadowOn) shadowTick(t);
    if (singleSegment && !vid.seeking && t >= singleSegment.end - .025 && !vid.paused) {
      vid.pause(); singleSegment = null;
    }
    if ((view.step || view.test) && !loop && stepCue && t >= stepCue.end - 0.03 && !vid.paused) { vid.pause(); vid.currentTime = Math.max(stepCue.start, stepCue.end - 0.05); stepCue = null; }
    const c = cueAt(t), id = c?.id || null;
    if (id !== curId) {
      curId = id; if (c) { stepCue = c; revealedCue = null; }
      drawSub();
      $$('.cue.cur', cl).forEach((x) => x.classList.remove('cur'));
      const row = id && cl.querySelector(`[data-id="${id}"]`);
      if (row) { row.classList.add('cur'); followCue(row); }
    }
    if (v.trim && !vid.seeking) {
      if (t < v.trim.start - 0.05) vid.currentTime = v.trim.start;
      else if (t >= v.trim.end) { if (!vid.paused) vid.pause(); vid.currentTime = Math.max(v.trim.start, v.trim.end - 0.05); }
    }
    if (Date.now() - seekT > 200 || vid.paused) { seekT = Date.now(); drawSeek?.(); }   // the bar: 5 times a second while playing (was a timer that never stopped)
    if (Date.now() - saveT > 3000) { saveT = Date.now(); savePos(); }
    rafId = vid.paused ? 0 : requestAnimationFrame(tick);   // runs only while playing (no work while paused)
  }
  const kick = () => { if (!rafId) rafId = requestAnimationFrame(tick); };   // one update after a seek while paused, or the loop again on play
  let savedT = -1;
  async function savePos() {   // only when the position really changed
    if (!vid) return; const t = vid.currentTime; if (Math.abs(t - savedT) < 0.5) return; savedT = t;
    const cur = await db.get('videos', v.id); if (cur) { cur.lastTime = t; cur.playedAt = Date.now(); await saveVideoMeta(cur); }
  }
  const playFrom = (c) => { if (!vid || !c) return; singleSegment = null; vid.currentTime = v.trim ? Math.max(v.trim.start, Math.min(v.trim.end - 0.05, c.start + 0.01)) : c.start + 0.01; stepCue = c; revealedCue = null; if (loop) { loop = { start: c.start, end: c.end }; loopN = 0; } vid.play(); };

  // ---- cloze grading ----
  async function gradeHole(c, hi, ok) {
    const h = c.holes[hi];
    h[ok ? 'ok' : 'ng'] = (h[ok ? 'ok' : 'ng'] || 0) + 1; h.last = ok ? 'ok' : 'ng'; h.lastAt = Date.now();
    await db.put('cues', c);
    const vocab = (await wordsByHead(vlang)).get(headKey(h.text))?.[0];
    await recordAnswer({ sessionId: 'video:' + v.id, qid: `${c.id}:${hi}:${Date.now()}`, wordId: vocab ? vocab.id : `cz_${c.id}_${h.s}`, direction: 'audio', format: 'video-cloze', mode: 'video', prompt: c.en, answer: ok ? '聞けた' : '聞けなかった', ms: 0, self: true,
      results: [{ skill: 'listening', correct: ok, hint: false }], srs: vocab ? { kind: 'word', lang: vlang } : { kind: 'cloze', lang: vlang } });
    $('#grade', el).innerHTML = ok ? '' : `<div class="hgrade">「${esc(h.text)}」を記録しました <button class="btn sm" data-addng="${c.id}:${hi}">単語帳に追加</button></div>`;
    drawSub(); drawList(); drawStats();
  }
  async function addToVocab(c, hi) {
    const h = c.holes[hi];
    const ref = { videoId: v.id, cueId: c.id, time: c.start, text: c.en };
    const exist = (await wordsByHead(vlang)).get(headKey(h.text))?.[0];
    if (exist) {
      exist.videoRefs = [...(exist.videoRefs || []).filter((r) => r.cueId !== c.id), ref];
      const s0 = exist.senses[0]; if (!(s0.examples || []).some((x) => x.en === c.en)) s0.examples = [...(s0.examples || []), { en: c.en, ja: jaFor(c) || '' }];
      await saveWord(exist); toast(`「${exist.headword}」は登録済み：例文と動画の位置を追加しました`); return;
    }
    const w = newWord({ lang: vlang, headword: h.text, source: { type: 'video', ...ref }, tags: ['動画の穴埋め'], senses: [newSense({ examples: [{ en: c.en, ja: jaFor(c) || '' }] })] });
    w.videoRefs = [ref]; await saveWord(w);
    toast(`「${w.headword}」を単語帳に追加しました（意味は詳細画面で入力）`);
  }

  // ---- subtitle box & list taps ----
  function onTextTap(e) {
    const hole = e.target.closest('.hole');
    if (hole) {
      e.stopPropagation();
      const c = cues.find((x) => x.id === hole.dataset.cue), hi = +hole.dataset.hole;
      const set = revealed.get(c.id) || new Set(); revealed.set(c.id, set);
      if (set.has(hi)) { set.delete(hi); $('#grade', el).innerHTML = ''; }
      else {
        set.add(hi);
        $('#grade', el).innerHTML = `<div class="hgrade">「${esc(c.holes[hi].text)}」 <button class="btn sm ok" data-g="1" data-c="${c.id}" data-h="${hi}">聞けた</button><button class="btn sm ng" data-g="0" data-c="${c.id}" data-h="${hi}">聞けなかった</button></div>`;
      }
      drawSub(); drawList(); return true;
    }
    const tok = e.target.closest('.ctok');
    if (tok && editing) {
      e.stopPropagation();
      const c = cues.find((x) => x.id === tok.dataset.cue);
      toggleToken(c, +tok.dataset.t, view.clozeUnit, vlang);
      db.put('cues', c); revealed.delete(c.id);
      drawSub(); drawList(); drawStats(); return true;
    }
    return false;
  }
  sub.addEventListener('click', (e) => {
    if (onTextTap(e)) return;
    const c = cues.find((x) => x.id === curId); if (!c) return;
    if (view.test && revealedCue !== c.id) { revealedCue = c.id; drawSub(); return; }
    if (!editing && c.en) wordFromCue(c.id);
  });
  $('#grade', el).addEventListener('click', async (e) => {
    const g = e.target.closest('[data-g]');
    if (g) { const c = cues.find((x) => x.id === g.dataset.c); return gradeHole(c, +g.dataset.h, g.dataset.g === '1'); }
    const a = e.target.closest('[data-addng]'); if (a) { const [cid, hi] = a.dataset.addng.split(':'); await addToVocab(cues.find((x) => x.id === cid), +hi); $('#grade', el).innerHTML = ''; }
  });
  $('#czStats', el).addEventListener('click', async (e) => { const a = e.target.closest('[data-addng]'); if (a) { const [cid, hi] = a.dataset.addng.split(':'); await addToVocab(cues.find((x) => x.id === cid), +hi); a.disabled = true; } });
  cl.addEventListener('click', (e) => {
    if (onTextTap(e)) return;
    const w = e.target.closest('[data-word]'); if (w) return wordFromCue(w.dataset.word);
    const ja = e.target.closest('[data-ja]'); if (ja) return editJa(ja.dataset.ja);
    const ed = e.target.closest('[data-edit]'); if (ed) return editCue(ed.dataset.edit);
    const row = e.target.closest('.cue'); if (!row) return;
    const c = cues.find((x) => x.id === row.dataset.id);
    const repeat = e.target.closest('[data-repeat]');
    if (repeat) {
      const segment = c.segments[Number(repeat.dataset.repeat)];
      if (!vid || !segment) return;
      if (dictOn) return setRange(segment.start, segment.end, c.en);
      playFrom({ ...c, ...segment });
      if (!loop) singleSegment = segment;
      return;
    }
    if (dictOn) { dictTyped = ''; return setRange(c.start, c.end, c.en); }   // dictation: the tapped sentence becomes the repeat range
    if (shadowOn) { shadow.cur = c; shadow.n = 0; shadow.waiting = false; clearTimeout(shadowT); }
    playFrom(c);
    if (!loop && c.studySet && !shadowOn) singleSegment = c;
  });

  // ================= dictation / shadowing tools =================
  const STEPS = [3, 5, 10], RATES = [1, 0.7, 0.5];
  let stepSec = (await getSetting('video.stepSec', 3)) || 3, dictOn = false, rangeMode = null, shadowOn = false, shadowT = null;
  const shadow = { gap: (await getSetting('video.shGap', 1.5)) || 1.5, rep: (await getSetting('video.shRep', 1)) || 1, n: 0, waiting: false };
  // words of a cue with estimated times (spread by characters inside the cue)
  const toks = (c) => { const out = []; const re = /\S+/g; let m; const L0 = Math.max(1, (c.en || '').length); while ((m = re.exec(c.en || ''))) out.push({ w: m[0], t0: c.start + ((c.end - c.start) * m.index) / L0, t1: c.start + ((c.end - c.start) * (m.index + m[0].length)) / L0 }); return out; };
  // text inside the current range (A–B), or the current / next sentence
  function targetText() {
    if (ab?.b != null) {
      if (ab.text) return ab.text;
      return cues.flatMap((c) => toks(c).filter((k) => (k.t0 + k.t1) / 2 >= ab.a - 0.05 && (k.t0 + k.t1) / 2 <= ab.b + 0.05).map((k) => k.w)).join(' ');
    }
    const t = vid?.currentTime || 0; const c = cueAt(t) || cues.find((x) => x.start >= t) || cues[cues.length - 1];
    return c?.en || '';
  }
  function setRange(a, b, text = null) {
    if (b - a < 0.2) return;
    ab = { a: Math.max(0, a), b: Math.min(vid?.duration || b, b), text }; loop = null;
    if (vid) { vid.currentTime = ab.a; vid.play().catch(() => {}); }
    applyView(); drawSeek(); if (dictOn) drawDict();
  }
  function clearRange() { ab = null; rangeMode = null; applyView(); drawSeek(); if (dictOn) drawDict(); }
  // ---- wide seek bar: tap = jump, drag = choose a range that repeats ----
  const seekEl = $('#seek', el);
  function drawSeek() {
    if (!vid || !seekEl) return;
    const D = vid.duration || 1, t = vid.currentTime || 0;
    $('#sPlayed', el).style.width = `${(t / D) * 100}%`; $('#sHead', el).style.left = `${(t / D) * 100}%`;
    const r = $('#sRange', el);
    if (ab?.b != null) { r.hidden = false; r.style.left = `${(ab.a / D) * 100}%`; r.style.width = `${((ab.b - ab.a) / D) * 100}%`; $('#sRangeTxt', el).textContent = `${fmtT(ab.a)}–${fmtT(ab.b)}`; $('#sClear', el).hidden = false; }
    else { r.hidden = true; $('#sRangeTxt', el).textContent = ''; $('#sClear', el).hidden = true; }
    $('#sAB', el).hidden = !$('#sClear', el).hidden;
    $('#sTime', el).textContent = `${fmtT(t)} / ${fmtT(D)}`;
  }
  if (seekEl) {
    let d = null;
    const posT = (x) => { const r = seekEl.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * (vid?.duration || 0); };
    seekEl.addEventListener('pointerdown', (e) => { if (!vid) return; seekEl.setPointerCapture(e.pointerId); d = { x0: e.clientX, t0: posT(e.clientX), moved: false }; });
    seekEl.addEventListener('pointermove', (e) => {
      if (!d) return; if (!d.moved && Math.abs(e.clientX - d.x0) < 8) return; d.moved = true;
      const t1 = posT(e.clientX), a = Math.min(d.t0, t1), b = Math.max(d.t0, t1), D = vid.duration || 1, r = $('#sRange', el);
      r.hidden = false; r.style.left = `${(a / D) * 100}%`; r.style.width = `${((b - a) / D) * 100}%`; $('#sRangeTxt', el).textContent = `${fmtT(a)}–${fmtT(b)}`;
    });
    seekEl.addEventListener('pointerup', (e) => {
      if (!d) return; const t1 = posT(e.clientX), x = d; d = null;
      if (!x.moved) { vid.currentTime = t1; if (ab?.b != null && (t1 < ab.a || t1 > ab.b)) ab = null; drawSeek(); applyView(); return; }
      setRange(Math.min(x.t0, t1), Math.max(x.t0, t1));
    });
    seekEl.addEventListener('pointercancel', () => { d = null; drawSeek(); });
    $('#sClear', el).onclick = clearRange;
    $('#sAB', el).onclick = () => $('#qRange', el).click();
    vid?.addEventListener('loadedmetadata', drawSeek);
  }
  // ---- back / forward (seconds cycle 3 → 5 → 10), speed (1 → 0.7 → 0.5) ----
  const drawSteps = () => { $('#back', el).textContent = `⟲${stepSec}`; $('#fwd', el).textContent = `${stepSec}⟳`; };
  drawSteps();
  // long press on ⟲ / ⟳: the seconds appear above the button; slide onto one and let go to choose
  const pressSteps = (btn) => {
    let timer = null, pop = null, pick = null, used = false;
    const close = () => { pop?.remove(); pop = null; pick = null; };
    btn.addEventListener('pointerdown', (e) => {
      used = false; clearTimeout(timer);
      timer = setTimeout(() => {
        used = true; try { navigator.vibrate?.(10); } catch {}
        const r = btn.getBoundingClientRect();
        pop = document.createElement('div'); pop.className = 'vsteps';
        pop.innerHTML = STEPS.map((n) => `<span data-n="${n}" class="${n === stepSec ? 'on' : ''}">${n}秒</span>`).join('');
        document.body.appendChild(pop);
        pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2))}px`; pop.style.top = `${r.top - pop.offsetHeight - 10}px`;
        try { btn.setPointerCapture(e.pointerId); } catch {}
      }, 420);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!pop) return;
      const o = document.elementFromPoint(e.clientX, e.clientY)?.closest('.vsteps span');
      $$('span', pop).forEach((x) => x.classList.toggle('hover', x === o)); pick = o ? +o.dataset.n : null;
    });
    const choose = async (n) => { close(); stepSec = n; drawSteps(); toast(`戻す・送る：${n}秒`, 1200); await setSetting('video.stepSec', n); };
    // let go on a choice → chosen. Let go elsewhere (or iPhone cancelled the touch) → the choices stay open and can be tapped
    const keepOpen = () => {
      if (!pop || pop.dataset.tap) return; pop.dataset.tap = '1';
      pop.addEventListener('click', (e) => { const o = e.target.closest('span[data-n]'); if (o) choose(+o.dataset.n); });
      setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!pop?.contains(e.target)) { close(); document.removeEventListener('pointerdown', off, true); } }, true), 0);
    };
    const up = () => { clearTimeout(timer); if (!pop) return; if (pick) choose(pick); else keepOpen(); };
    btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', () => { clearTimeout(timer); keepOpen(); });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => { if (used) { e.stopImmediatePropagation(); e.preventDefault(); used = false; } }, true);
  };
  pressSteps($('#back', el)); pressSteps($('#fwd', el));
  $('#back', el).onclick = () => { if (vid) vid.currentTime = Math.max(ab?.b != null ? ab.a : 0, vid.currentTime - stepSec); };
  $('#fwd', el).onclick = () => { if (vid) vid.currentTime = Math.min(ab?.b != null ? ab.b - 0.05 : vid.duration || 1e9, vid.currentTime + stepSec); };
  // ---- range from the subtitle text: tap the first word, then the last word ----
  $('#qRange', el).onclick = () => { rangeMode = rangeMode ? null : { first: null }; if (rangeMode) toast('字幕の一覧で、区間の最初の語→最後の語をタップ', 3000); applyView(); };
  cl.addEventListener('click', (e) => {
    if (!rangeMode) return;
    const k = e.target.closest('[data-rk]'); if (!k) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const [cid, i] = k.dataset.rk.split(':'); const c = cues.find((x) => x.id === cid), tk = toks(c)[+i];
    if (!rangeMode.first) { rangeMode.first = { c, i: +i, tk }; k.classList.add('rsel'); toast('最後の語をタップ', 1500); return; }
    let A = rangeMode.first, B = { c, i: +i, tk };
    if (B.tk.t0 < A.tk.t0) [A, B] = [B, A];
    const words = cues.filter((x) => x.start >= A.c.start && x.start <= B.c.start).flatMap((x) => toks(x).filter((t) => t.t0 >= A.tk.t0 - 0.001 && t.t0 <= B.tk.t0 + 0.001).map((t) => t.w));
    rangeMode = null;
    setRange(A.tk.t0 - 0.15, B.tk.t1 + 0.25, words.join(' '));
  }, true);

  // ---- dictation: type what you hear, compare word by word ----
  const normW = (w) => w.toLowerCase().replace(/[’‘]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
  function compareWords(answer, typed) {
    const A = answer.split(/\s+/).filter(Boolean), T = typed.split(/\s+/).filter(Boolean);
    const a = A.map(normW), t = T.map(normW);
    const names = new Set((v.properNouns || []).flatMap((x) => x.split(/\s+/)).map(normW).filter(Boolean));
    const del = (i) => (names.has(a[i]) ? 0 : 1);   // a registered proper noun may be left out (counted as given)
    const n = a.length, m = t.length, dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + del(i - 1); for (let j = 0; j <= m; j++) dp[0][j] = j;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = Math.min(dp[i - 1][j] + del(i - 1), dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === t[j - 1] ? 0 : 1));
    const ops = []; let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === t[j - 1] && dp[i][j] === dp[i - 1][j - 1]) { ops.push({ k: 'ok', a: A[i - 1], t: T[j - 1] }); i--; j--; }
      else if (i > 0 && names.has(a[i - 1]) && dp[i][j] === dp[i - 1][j]) { ops.push({ k: 'ok', a: A[i - 1], t: '', name: true }); i--; }
      else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) { ops.push({ k: 'sub', a: A[i - 1], t: T[j - 1] }); i--; j--; }
      else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) { ops.push({ k: 'miss', a: A[i - 1], t: '' }); i--; }
      else { ops.push({ k: 'extra', a: '', t: T[j - 1] }); j--; }
    }
    ops.reverse();
    // group: runs of matches become one chunk; runs of differences become one two-line chunk (typed in red / answer in green)
    const chunks = []; for (const o of ops) { const ok = o.k === 'ok'; const last = chunks[chunks.length - 1]; if (last && last.ok === ok) last.ops.push(o); else chunks.push({ ok, ops: [o] }); }
    const good = ops.filter((o) => o.k === 'ok').length;
    return { chunks, good, total: a.length, perfect: good === a.length && !ops.some((o) => o.k === 'extra') };
  }
  function diffHTML(r) {
    return r.chunks.map((ch) => ch.ok
      ? `<span class="dk ok">${ch.ops.map((o) => (o.name ? `<u class="dk-name">${esc(o.a)}</u>` : esc(o.a))).join(' ')}</span>`
      : `<span class="dk ng"><span class="dk-t">${esc(ch.ops.map((o) => o.t).filter(Boolean).join(' ')) || '＿'}</span><span class="dk-a">${esc(ch.ops.map((o) => o.a).filter(Boolean).join(' ')) || '（不要）'}</span></span>`).join(' ');
  }
  let dictTyped = '';
  function drawDict() {
    const box = $('#dict', el); box.hidden = !dictOn; if (!dictOn) return;
    const target = targetText();
    box.innerHTML = `<div class="row between"><b>ディクテーション</b><span class="small muted">${ab?.b != null ? `区間 ${fmtT(ab.a)}–${fmtT(ab.b)}` : '今の文'}</span></div>
      <div class="row"><button class="btn sm" id="dPlay">▶︎ 聞く（くり返し）</button><button class="btn sm" id="dNext">次の文へ</button></div>
      <div class="row dnames"><span class="small muted">固有名詞：</span>${(v.properNouns || []).map((x, i) => `<button class="chip" data-pn="${i}">${esc(x)}</button>`).join('') || '<span class="small muted">なし</span>'}<button class="link small" id="dPN">${(v.properNouns || []).length ? '編集' : '＋登録'}</button></div>
      <textarea id="dIn" rows="3" placeholder="聞こえた英語を入力" autocapitalize="off" autocorrect="off" spellcheck="false" ${langAttr(vlang)}>${esc(dictTyped)}</textarea>
      <div class="row"><button class="btn primary grow" id="dCheck">判定</button><button class="btn sm" id="dShow">答えを見る</button></div>
      <div id="dOut"></div>`;
    $('#dIn', el).oninput = (e) => (dictTyped = e.target.value);
    // proper nouns of this video: tap to insert; if left out, they count as given
    $$('[data-pn]', el).forEach((b) => (b.onclick = () => { const ta = $('#dIn', el), w = v.properNouns[+b.dataset.pn]; const p0 = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, p0) + (p0 && !/\s$/.test(ta.value.slice(0, p0)) ? ' ' : '') + w + ' ' + ta.value.slice(p0); dictTyped = ta.value; ta.focus(); }));
    $('#dPN', el).onclick = async () => {
      const cur = (v.properNouns || []).join(', ');
      const ans = prompt('この動画の固有名詞（人名・地名など）をカンマ区切りで\n例：Maria, Cleveland, Burns and Associates', cur); if (ans == null) return;
      v.properNouns = [...new Set(ans.split(/[,、，\n]/).map((x) => x.trim()).filter(Boolean))];
      const dbv = await db.get('videos', v.id); if (dbv) { dbv.properNouns = v.properNouns; await saveVideoMeta(dbv); }
      drawDict();
    };
    $('#dPlay', el).onclick = () => {
      if (ab?.b == null) { const t = vid.currentTime; const c = cueAt(t) || cues.find((x) => x.start >= t); if (c) setRange(c.start, c.end, c.en); return; }
      vid.currentTime = ab.a; vid.play().catch(() => {});
    };
    $('#dNext', el).onclick = () => { const c = cues.find((x) => x.start > (ab?.b != null ? ab.a : vid.currentTime) + 0.05); dictTyped = ''; if (c) setRange(c.start, c.end, c.en); else toast('最後の文です'); };
    $('#dShow', el).onclick = () => { $('#dOut', el).innerHTML = `<div class="dans">${esc(target)}</div>`; };
    $('#dCheck', el).onclick = async () => {
      if (!target) return toast('答えの字幕がありません');
      if (!dictTyped.trim()) return toast('聞こえた英語を入力してください');
      const r = compareWords(target, dictTyped);
      $('#dOut', el).innerHTML = `<div class="small ${r.perfect ? 'ok-text' : ''}">${r.perfect ? '全部合っています！' : `${r.good} / ${r.total} 語が一致`}</div><div class="dline">${diffHTML(r)}</div>`;
      // keep a small record on the sentence (used later for review)
      const c = cues.find((x) => x.start <= (ab?.a ?? vid.currentTime) + 0.3 && x.end >= (ab?.a ?? vid.currentTime)); if (c) { c.dict = { n: (c.dict?.n || 0) + 1, best: Math.max(c.dict?.best || 0, r.good / Math.max(1, r.total)), last: r.good / Math.max(1, r.total), at: Date.now() }; db.put('cues', c); }
    };
  }
  $('#qDict', el).onclick = () => {
    dictOn = !dictOn; if (dictOn) { shadowOn = false; view.test = true; dictTyped = ''; const t = vid?.currentTime || 0; const c = ab?.b != null ? null : cueAt(t) || cues.find((x) => x.start >= t); if (c) setRange(c.start, c.end, c.en); }
    else view.test = false;
    applyView(); drawDict(); drawShadow();
  };
  // ---- shadowing: play a sentence, pause so you can repeat, then go on ----
  function drawShadow() {
    const box = $('#shadow', el); box.hidden = !shadowOn; if (!shadowOn) return;
    box.innerHTML = `<div class="row between"><b>シャドーイング</b><span class="small muted" id="shSt">${shadow.waiting ? '今、くり返して言う番です' : '聞いて、続けて言う'}</span></div>
      <div class="row"><button class="btn sm" id="shGap">間：文の${shadow.gap}倍</button><button class="btn sm" id="shRep">${shadow.rep}回ずつ</button><button class="btn sm" id="shStart">${vid?.paused ? '▶︎ 始める' : '❚❚ 止める'}</button></div>
      <p class="hint">文が終わると止まり、その文の長さ×「間」だけ待って次へ進みます。字幕の表示は上の「字幕：」で切り替え。速さは「1×」ボタン。</p>`;
    $('#shGap', el).onclick = async () => { const G = [1, 1.5, 2]; shadow.gap = G[(G.indexOf(shadow.gap) + 1) % G.length]; await setSetting('video.shGap', shadow.gap); drawShadow(); };
    $('#shRep', el).onclick = async () => { const R = [1, 2, 3]; shadow.rep = R[(R.indexOf(shadow.rep) + 1) % R.length]; await setSetting('video.shRep', shadow.rep); drawShadow(); };
    $('#shStart', el).onclick = () => { if (vid.paused) { clearTimeout(shadowT); shadow.waiting = false; const c = cueAt(vid.currentTime) || cues.find((x) => x.start >= vid.currentTime); if (c) { shadow.cur = c; shadow.n = 0; vid.currentTime = c.start; } vid.play().catch(() => {}); } else { vid.pause(); clearTimeout(shadowT); } drawShadow(); };
  }
  function shadowTick(t) {
    const c = shadow.cur; if (!c || shadow.waiting || vid.paused) return;
    if (t >= c.end - 0.03) {
      vid.pause(); shadow.waiting = true; drawShadow();
      shadowT = setTimeout(() => {
        if (!shadowOn) return; shadow.waiting = false; shadow.n++;
        let nx = c; if (shadow.n >= shadow.rep) { shadow.n = 0; nx = cues.find((x) => x.start >= c.end - 0.01 && x.id !== c.id); }
        if (!nx) { drawShadow(); return toast('最後まで終わりました'); }
        shadow.cur = nx; vid.currentTime = nx.start; vid.play().catch(() => {}); drawShadow();
      }, Math.max(800, (c.end - c.start) * shadow.gap * 1000 / (vid.playbackRate || 1)));
    }
  }
  $('#qShadow', el).onclick = () => { shadowOn = !shadowOn; clearTimeout(shadowT); shadow.waiting = false; if (shadowOn) { dictOn = false; view.test = false; ab = null; loop = null; } applyView(); drawDict(); drawShadow(); drawSeek(); };

  // ---- controls ----
  const jump = (dir) => {
    if (!vid || !cues.length) return;
    const t = vid.currentTime, i = cues.findIndex((x) => x.id === curId);
    const c = dir < 0 ? [...cues].reverse().find((x) => x.start < (i >= 0 ? cues[i].start : t) - 0.05) || cues[0] : cues.find((x) => x.start > t + 0.05);
    playFrom(c);
  };
  // ⏮: back to the start of the sentence being heard; pressed again near its start → the previous sentence
  $('#prevCue', el).onclick = () => {
    if (!vid || !cues.length) return;
    const t = vid.currentTime, c = cueAt(t);
    if (c && t - c.start > 1.2) return playFrom(c);
    jump(-1);
  };
  $('#nextCue', el).onclick = () => jump(1);
  $('#again', el)?.addEventListener('click', () => {   // the phrase being heard, or the one just before if we're between phrases / at its start
    if (!vid || !cues.length) return;
    const t = vid.currentTime;
    const c = cueAt(t) && t - cueAt(t).start > 0.4 ? cueAt(t) : [...cues].reverse().find((x) => x.start < t - 0.05) || cues[0];
    playFrom(c);
  });
  $('#play', el).onclick = () => vid && (vid.paused ? vid.play() : vid.pause());
  $('#speed', el).onclick = async () => {
    const cur = vid?.playbackRate || 1;
    const nx = RATES[(RATES.indexOf(cur) + 1) % RATES.length] ?? 1;
    if (vid) vid.playbackRate = nx; $('#speed', el).textContent = `${nx}×`; await setSetting('video.speed', nx);
  };
  $('#qMode', el).onclick = () => { const i = MODES.findIndex((m) => m[0] === view.mode); view.mode = MODES[(i + 1) % MODES.length][0]; saveView(); applyView(); };
  $('#qCloze', el).onclick = () => { view.cloze = !view.cloze; if (!view.cloze) editing = false; saveView(); applyView(); drawStats(); if (view.cloze && !cues.some((c) => c.holes?.length)) toast(view.clozeAuto ? '設定の「自動の候補で穴を作る」で穴を作れます' : '設定の「穴を選ぶ」で、字幕の語をタップして隠せます', 3200); };
  $('#qLoop', el).onclick = () => {
    if (loop) loop = null;
    else {
      const t = vid?.currentTime || 0;
      const c = cues.find((x) => x.id === curId) || [...cues].reverse().find((x) => x.start <= t);
      if (!c) return toast('ループする字幕がありません');
      loop = { start: c.start, end: c.end }; loopN = 0; ab = null; if (vid) { vid.currentTime = c.start; vid.play(); }
    }
    applyView();
  };
  $('#loopBtn', el).onclick = () => $('#qLoop', el).click();
  $('#qTest', el).onclick = () => { view.test = !view.test; revealedCue = null; saveView(); applyView(); };
  const seg = (id, key, num = true) => ($('#' + id, el).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; view[key] = num ? +b.dataset.v : b.dataset.v; saveView(); applyView(); });
  seg('order', 'order', false); seg('primary', 'primary', false); seg('opEn', 'opEn'); seg('opJa', 'opJa'); seg('fsEn', 'fsEn'); seg('fsJa', 'fsJa'); seg('loopMax', 'loopMax'); seg('clozeUnit', 'clozeUnit', false);
  $('#clozeAuto', el).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; view.clozeAuto = b.dataset.v === '1'; saveView(); applyView(); };
  $('#step', el).onchange = (e) => { view.step = e.target.checked; saveView(); applyView(); };
  $('#jaHint', el).onchange = (e) => { view.jaHint = e.target.checked; saveView(); applyView(); };
  $('#tAB', el).onclick = () => {
    const t = vid?.currentTime || 0;
    if (!ab) { ab = { a: t, b: null }; loop = null; toast('A地点を設定。もう一度押すとB地点'); }
    else if (ab.b == null) { if (t <= ab.a + 0.3) return toast('A地点より後で押してください'); ab.b = t; if (vid) vid.currentTime = ab.a; }
    else ab = null;
    applyView();
  };
  $('#edit', el).onclick = () => { editing = !editing; if (editing && !view.cloze) view.cloze = true; applyView(); };
  $('#autoGo', el).onclick = async () => {
    const vocab = (await db.all('words')).filter((w) => (w.lang || 'en') === vlang);
    let n = 0;
    for (const c of cues) {
      if (!c.en) continue;
      const manual = (c.holes || []).filter((h) => !h.auto);
      const cand = candidates(c.en, vocab, view.clozeUnit, vlang).filter((x) => !manual.some((h) => !(x.e < h.s || x.s > h.e)));
      const keepStats = Object.fromEntries((c.holes || []).filter((h) => h.auto).map((h) => [`${h.s}-${h.e}`, h]));
      c.holes = [...manual, ...cand.map((x) => ({ ...(keepStats[`${x.s}-${x.e}`] || {}), s: x.s, e: x.e, text: x.text, auto: true, why: x.why }))].sort((a, b) => a.s - b.s);
      n += cand.length;
    }
    await db.tx(['cues'], 'readwrite', (t) => cues.forEach((c) => t.objectStore('cues').put(c)));
    view.cloze = true; saveView(); revealed.clear(); applyView(); drawStats();
    toast(n ? `${n}か所を穴にしました（単語帳の語・句動詞・TOEIC頻出語）。手動の穴はそのままです` : '候補が見つかりませんでした');
  };
  $('#exportJa', el).onclick = exportJaSource;
  $('#clearJa', el).onclick = clearJa;
  $('#reviewJa', el).onclick = showJaReview;
  $('#askClaude', el).onclick = async () => {
    const text = `order の順に文脈を確認して各字幕を日本語に訳し、教材IDと cueId を維持して {"materialId":"…","translations":[{"cueIds":["字幕ID"],"ja":"訳文"}]} 形式のJSONだけ返してください。1つの訳が複数字幕に対応する場合は cueIds に全IDを入れてください。同じ字幕に複数の訳文が対応する場合は別々の行にしてください。英文・表示順・時刻は出力に含めないでください。\n\n${jaSource()}`;
    try { await navigator.clipboard.writeText(text); toast('翻訳依頼文をコピーしました'); }
    catch { pasteShow(text); }
  };
  $('#make', el).addEventListener('click', (e) => { const p = e.target.closest('[data-paste]'); if (p) pasteDialog(p.dataset.paste); });
  $('#fEn', el).onchange = (e) => importFile(e, 'en');
  $('#fJa', el).onchange = (e) => importFile(e, 'ja');
  $('#addCue', el).onclick = () => editCue(null);
  $('#menu', el).onclick = menu;

  // put the video file back (same subtitles and records) when the saved data became unreadable
  function relinkVideo() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'video/*';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const { copyBlob } = await import('./media-audio.js');
      toast('保存中…', 10000);
      try {
        const { saveVideoCopy } = await import('./media-audio.js'); const sv = await saveVideoCopy(f, { onStep: (m) => toast(m, 10000) });
        await putVideoBlob(v.id, sv.blob);
        delete v.blob; v.size = sv.blob.size; delete v.audioTrack; delete v.audioBlob; v.audioChecked = true; v.audioFixed = true; if (sv.info) v.audioInfo = sv.info; if (sv.trackIndex != null) v.audioTrack = sv.trackIndex;
        await saveVideoMeta(v); toast('動画を選び直しました'); videoPlay(el, params);
      }
      catch (e) { toast('保存できませんでした: ' + (e?.message || e)); }
    };
    inp.click();
  }
  function jaSource() {
    return JSON.stringify(videoJaSource(v.id, scriptOrder()), null, 2);
  }
  function exportJaSource() {
    const url = URL.createObjectURL(new Blob([jaSource()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `Englabo-${v.id}-translation-source.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  async function clearJa() {
    if (!(await confirmDialog({ title: '日本語訳を削除', body: '<p>この教材の日本語訳と要確認の対応を消します。</p>', okLabel: '日本語訳だけ削除', danger: true }))) return;
    try {
      await saveVideoJa(v.id, new Map(), new Map(), { clear: true });
      await refreshJa();
      toast('日本語訳を削除しました');
    } catch (error) { toast(error.message); }
  }
  function showJaReview() {
    const open = cues.filter(c => jaView.needsReview(c) || jaView.review.includes(c.id));
    const missing = jaView.review.filter(id => !cues.some(c => c.id === id));
    confirmDialog({ title: '日本語訳の要確認',
      body: open.length || missing.length ?
        `<p>字幕が編集または置換されました。対応を確認したら字幕行の「訳」から保存できます。複数行共通の訳は、対応するIDで再取り込みしてください。</p>
        ${open.map(c => `<p>${esc(c.en)}<br>${esc(jaView.draft(c))}</p>`).join('')}
        ${missing.length ? `<details><summary>削除・置換された字幕 ${missing.length}件</summary>${missing.map(id =>
          `<p>${esc(id)}<br>${esc(jaView.draft({ id }))}</p>`).join('')}</details>` : ''}` : '<p>要確認の日本語訳はありません。</p>',
      okLabel: '閉じる', cancelLabel: null });
  }
  async function editJa(id) {
    const cue = cues.find(c => c.id === id);
    if (!cue) return;
    const expected = cueStamps([cue]), dlg = $('#dialog');
    const ok = await confirmDialog({ title: '日本語訳を編集',
      body: `<p>${esc(cue.en)}</p><label class="field"><span>日本語訳（空欄で削除）</span><textarea id="editJaText" rows="4">${esc(jaView.draft(cue))}</textarea></label>`,
      okLabel: '日本語訳だけ保存' });
    if (!ok) return;
    try {
      const ja = $('#editJaText', dlg).value.trim();
      const result = await saveVideoJa(v.id, new Map([[id, ja ? [ja] : []]]), expected);
      await refreshJa();
      toast(result.needsReview.length ? '字幕が変更されました。開き直して確認してください' : '日本語訳を更新しました');
    } catch (error) { toast(error.message); }
  }
  async function importText(text, lang) {
    const list = parseSubs(text);
    if (lang === 'ja') return importTranslations(text, list);
    if (!list.length) return toast('字幕を読み取れませんでした（SRT / VTT形式か確認してください）');
    if (cues.some(c => c.en) && !(await confirmDialog({ title: `${TL}字幕を置き換えますか？`, body: '<p>字幕IDが変わるため、日本語訳の対応は要確認になります。</p>', okLabel: '置き換える' }))) return;
    // Existing inline translations are retained as reviewable drafts when their IDs disappear.
    const inline = cues.filter(c => c.ja && !jaRecords.some(row => row.cueId === c.id));
    if (inline.length) await saveVideoJa(v.id, new Map(inline.map(c => [c.id, [c.ja]])), cueStamps(inline));
    const replacement = list.map(x => ({ id: uid('c_'), videoId: v.id, start: x.start, end: x.end, en: x.text, ja: '' }));
    await replaceCues(v.id, replacement);
    toast(`${list.length}行を読み込みました`);
    videoPlay(el, params);
  }
  async function importTranslations(text, timed) {
    const base = scriptOrder().filter(c => c.en);
    if (!base.length) return toast('先に英語字幕を追加してください');
    try {
      const expected = cueStamps(base);
      const structured = /^[\[{]/.test(text.trim());
      let patch, unmatched = [], scriptReview = [];
      if (structured) {
        const data = JSON.parse(text);
        const idPatch = Array.isArray(data?.translations) && (data.translations.some(row => row && Object.hasOwn(row, 'cueIds')) ||
          !data.translations.length && data.materialId != null);
        if (idPatch) {
          patch = parseJaPatch(text, v.id);
          unmatched = [...patch.keys()].filter(id => !expected.has(id));
        } else {
          const result = planScriptJa(base, readScriptJa(data, v.id, v.name));
          patch = result.patch;
          scriptReview = result.review;
          unmatched = scriptReview.map(row => row.number);
        }
      } else {
        const rows = timed.length ? timed.map(row => ({ ...row, ja: row.text })) : translationRows(text);
        const old = planTranslations(base, rows);
        patch = new Map([...old.changes].map(([id, cue]) => [id, [cue.ja]]));
        unmatched = old.unmatched;
      }
      const targets = new Map(base.map(c => [c.id, c.en]));
      const flagged = base.filter(c => patch.has(c.id) && (jaView.needsReview(c) || (c.translationRevision && !jaFor(c))));
      const dlg = $('#dialog');
      const reviewDetails = scriptReview.length ? `<details><summary>要確認の入力を表示</summary><ol class="small">${scriptReview.map(row =>
        `<li value="${row.number}">${esc(row.en)}<br>${esc(row.reason)}</li>`).join('')}</ol></details>` : '';
      const deletionCount = [...patch.values()].filter(values => !values.length).length;
      const sample = [...patch].filter(([id]) => targets.has(id)).slice(0, 10).map(([id, values]) =>
        `<li>${esc(targets.get(id))}<br>${values.length ? esc(values.map(value => value.ja ?? value).join(' / ')) : '日本語訳を削除'}</li>`).join('');
      if (!(await confirmDialog({
        title: '日本語訳の対応を確認',
        body: `<p>教材 ${esc(v.name)}・取込対象 ${patch.size}件${deletionCount ? `（訳を削除 ${deletionCount}件）` : ''}。</p>${reviewDetails}${unmatched.length ? `<p>要確認 ${unmatched.length}件。対応先 ${unmatched.slice(0, 10).map(esc).join('、')}</p>` : ''}
          ${sample ? `<ol class="small">${sample}</ol>` : ''}
          ${flagged.length ? `<p>編集後に訳の確認が必要な字幕を選んでください。</p><div class="stack">${flagged.map((cue, i) => `<label class="chk">
            <input type="checkbox" data-ja-confirm="${i}"><span>${esc(cue.en)}<br>${esc(patch.get(cue.id).map(value => value.ja ?? value).join(' / '))}</span></label>`).join('')}</div>` : ''}`,
        okLabel: patch.size ? '日本語訳だけ保存' : '閉じる', cancelLabel: patch.size ? 'キャンセル' : null,
      })) || !patch.size) return;
      const approved = new Set($$('[data-ja-confirm]:checked', dlg).map(input => Number(input.dataset.jaConfirm)));
      flagged.forEach((cue, i) => { if (!approved.has(i)) expected.delete(cue.id); });
      const result = await saveVideoJa(v.id, patch, expected);
      await refreshJa();
      const pending = new Set([...unmatched, ...result.needsReview]);
      toast(pending.size ? `適用できなかった字幕があります（要確認 ${pending.size}件）` : '日本語訳を保存しました');
    } catch (error) {
      toast('日本語訳を読み込めませんでした。' + (error?.message || error), 6000);
    }
  }
  async function importFile(e, lang) { const f = e.target.files[0]; e.target.value = ''; if (f) importText(await f.text(), lang); }
  async function pasteDialog(lang) {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${lang === 'en' ? TL + '字幕' : '日本語訳'}を貼り付け</h3>
      <textarea id="pt" rows="10" placeholder="${lang === 'ja' ? '英文と日本語訳のJSON、または字幕IDの差分JSONを貼り付け' : '1&#10;00:00:01,000 --> 00:00:03,500&#10;Hello, everyone.'}" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="row end"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">取り込む</button></div></form>`;
    dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue === 'ok') importText($('#pt', dlg).value, lang); };
    dlg.showModal();
  }

  async function editCue(id) {
    const isNew = !id;
    const t = vid?.currentTime || 0;
    const c = isNew ? { id: uid('c_'), videoId: v.id, start: t, end: t + 2, en: '', ja: '' } : cues.find((x) => x.id === id);
    vid?.pause();
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${isNew ? '字幕を追加' : '字幕を編集'}</h3>
      <div class="row"><label class="field grow"><span>開始（秒または分:秒）</span><input id="es" value="${c.start.toFixed(3)}" inputmode="decimal"></label><button type="button" class="btn sm" id="nowS">現在位置</button></div>
      <div class="row"><label class="field grow"><span>終了（秒または分:秒）</span><input id="ee" value="${c.end.toFixed(3)}" inputmode="decimal"></label><button type="button" class="btn sm" id="nowE">現在位置</button></div>
      <label class="field"><span>英語</span><textarea id="een" rows="2" autocapitalize="off" spellcheck="false">${esc(c.en)}</textarea></label>
      <div class="row between">${isNew ? '<span></span>' : '<button class="btn sm danger" value="del">削除</button>'}<span class="row"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">保存</button></span></div></form>`;
    $('#nowS', dlg).onclick = () => ($('#es', dlg).value = fmtT(vid?.currentTime || 0));
    $('#nowE', dlg).onclick = () => ($('#ee', dlg).value = fmtT(vid?.currentTime || 0));
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (dlg.returnValue === 'del') {
        if (!(await confirmDialog({ title: 'この字幕を削除', okLabel: '削除', danger: true }))) return;
        if (c.itemId && v.from?.material) {
          const current = await db.get('videos', v.id);
          const removedStudioItems = [...new Set([...(current.removedStudioItems || []), c.itemId])];
          await db.tx(['videos','cues'], 'readwrite', tx => {
            tx.objectStore('videos').put({ ...current, removedStudioItems });
            tx.objectStore('cues').delete(c.id);
          });
        } else await db.delete('cues', c.id);
        cues = cues.filter((x) => x.id !== c.id); await refreshJa(); return;
      }
      if (dlg.returnValue !== 'ok') return;
      const s = parseT($('#es', dlg).value), e = parseT($('#ee', dlg).value);
      if (!(s >= 0) || !(e > s)) return toast('時間が正しくありません（終了は開始より後）');
      const newEn = $('#een', dlg).value.trim();
      if (newEn !== c.en) {
        c.holes = []; c.enEdited = true; c.translationRevision = uid('rev_');
        if (c.ja) c.legacyJaReview = true;
      }
      if (Math.abs(s - c.start) > .00051 || Math.abs(e - c.end) > .00051) {
        c.timeEdited = true;
        if (c.segments?.length) c.segments = [{ start: s, end: e }, ...c.segments.slice(1)];
        Object.assign(c, { start: s, end: e });
      }
      c.en = newEn;
      await db.put('cues', c);
      if (isNew) cues.push(c);
      cues.sort(compareVideoCues);
      curId = null; await refreshJa(); toast('保存しました');
    };
    dlg.showModal();
  }

  async function wordFromCue(id) {
    const c = cues.find((x) => x.id === id);
    vid?.pause();
    if ((v.lang || 'en') !== 'en') { const w = await pickWordsDialog({ text: c.en, ja: jaFor(c), lang: v.lang, source: { type: 'video', videoId: v.id, cueId: c.id, time: c.start, text: c.en }, title: '字幕から語句を登録' }); if (w) { w.videoRefs = [...(w.videoRefs || []).filter((r) => r.cueId !== c.id), { videoId: v.id, cueId: c.id, time: c.start, text: c.en }]; await saveWord(w); } return; }
    const toks = c.en.split(/(\s+)/);
    let n = 0;
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>字幕から単語を登録</h3>
      <p class="hint">語をタップ（隣り合う語を続けて選ぶと熟語）</p>
      <div class="ptext">${toks.map((tk) => { if (!tk.trim()) return tk; const m = tk.match(/^([^A-Za-z']*)([A-Za-z][A-Za-z'\-]*)([^A-Za-z']*)$/); return m ? `${esc(m[1])}<span class="tok" data-n="${n++}">${esc(m[2])}</span>${esc(m[3])}` : esc(tk); }).join('')}</div>
      ${jaFor(c) ? `<p class="small muted">${esc(jaFor(c))}</p>` : ''}
      <label class="field"><span>登録する語（編集可）</span><input id="wh" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>意味（「/」で複数・あとで入力も可）</span><input id="wm"></label>
      <label class="chk"><input type="checkbox" id="wb"> ブックマークする</label>
      <div class="row end"><button class="btn ghost" value="cancel">キャンセル</button><button class="btn primary" value="ok">登録</button></div></form>`;
    const sync = () => {
      const on = $$('.tok.on', dlg).map((t) => +t.dataset.n);
      const all = $$('.tok', dlg);
      if (!on.length) return;
      $('#wh', dlg).value = all.slice(Math.min(...on), Math.max(...on) + 1).map((t) => t.textContent).join(' ');
    };
    $('.ptext', dlg).onclick = (e) => { const t = e.target.closest('.tok'); if (t) { t.classList.toggle('on'); sync(); } };
    dlg.returnValue = '';
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return;
      const head = $('#wh', dlg).value.trim();
      if (!head) return toast('語を選んでください');
      const ref = { videoId: v.id, cueId: c.id, time: c.start, text: c.en };
      const exist = findDuplicate(await wordsByHead(), head, splitList($('#wm', dlg).value));
      if (exist) {
        exist.videoRefs = [...(exist.videoRefs || []).filter((r) => r.cueId !== c.id), ref];
        const s0 = exist.senses[0];
        if (!(s0.examples || []).some((x) => x.en === c.en)) s0.examples = [...(s0.examples || []), { en: c.en, ja: jaFor(c) || '' }];
        const add = splitList($('#wm', dlg).value).filter((m) => !s0.meanings.includes(m));
        s0.meanings.push(...add);
        if ($('#wb', dlg).checked) exist.bookmarked = true;
        await saveWord(exist);
        toast(`「${exist.headword}」は登録済み：例文と動画の位置を追加しました`);
      } else {
        const w = newWord({ lang: v.lang || 'en', headword: head, bookmarked: $('#wb', dlg).checked, source: { type: 'video', ...ref },
          senses: [newSense({ meanings: splitList($('#wm', dlg).value), examples: [{ en: c.en, ja: jaFor(c) || '' }] })] });
        w.videoRefs = [ref];
        await saveWord(w);
        toast(`「${w.headword}」を登録しました`);
      }
    };
    dlg.showModal();
  }

  async function menu() {
    const dlg = $('#dialog');
    dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>${esc(v.name)}</h3>
      <label class="btn" for="fEn" data-close>${esc(TL)}字幕ファイルを読み込む</label>
      <label class="btn" for="fJa" data-close>日本語訳を読み込む（英文照合・字幕ID）</label>
      <button class="btn" value="pen">${esc(TL)}字幕を貼り付け</button>
      <button class="btn" value="pja">日本語訳を貼り付け</button>
      <button class="btn" value="copy" ${cues.some((c) => c.en) ? '' : 'disabled'}>${esc(TL)}字幕ID・英文・表示順を書き出す</button>
      <button class="btn" value="rename">名前を変更</button>
      <button class="btn danger" value="del">動画を削除</button>
      <button class="btn ghost" value="cancel">閉じる</button></form>`;
    dlg.querySelectorAll('[data-close]').forEach((l) => l.addEventListener('click', () => setTimeout(() => dlg.close(), 0)));
    dlg.returnValue = '';
    dlg.onclose = async () => {
      const r = dlg.returnValue;
      if (r === 'pen' || r === 'pja') pasteDialog(r === 'pen' ? 'en' : 'ja');
      else if (r === 'copy') exportJaSource(); else if (r === 'rename') {
        const name = prompt('動画の名前', v.name);
        if (name?.trim()) { const cur = await db.get('videos', v.id); cur.name = name.trim(); await saveVideoMeta(cur); videoPlay(el, params); }
      } else if (r === 'del') {
        if (!(await confirmDialog({ title: '動画を削除', body: '<p>動画と字幕を削除します。この動画から登録した単語は残りますが、動画へのリンクは使えなくなります。</p>', okLabel: '削除', danger: true }))) return;
        const old = await db.byIndex('cues', 'videoId', v.id);
        const mediaKeys = await releaseVideoMedia([v.id]);   // the studio's sets that use these sounds keep their own copy
        await db.tx(['videos', 'cues', 'vblobs', 'videoJa'], 'readwrite', (t) => { removeVideoJaInTx(t, v.id); t.objectStore('videos').delete(v.id); for (const key of mediaKeys) t.objectStore('vblobs').delete(key); old.forEach((c) => t.objectStore('cues').delete(c.id)); });
        toast('削除しました'); go('#video');
      }
    };
    dlg.showModal();
  }
  function pasteShow(text) {
    confirmDialog({ title: `翻訳依頼文`, body: `<p class="hint">全選択してコピーしてください</p><textarea rows="10" readonly style="width:100%">${esc(text)}</textarea>`, okLabel: '閉じる', cancelLabel: null });
  }


  // ---- start ----
  applyView(); drawStats();
  if (vid) {
    const t0 = params.get('t') != null ? Math.max(0, +params.get('t') - 0.3) : v.lastTime || 0;
    vid.addEventListener('loadedmetadata', () => { if (t0 && t0 < vid.duration) vid.currentTime = t0; }, { once: true });
    vid.addEventListener('play', () => { $('#play', el).textContent = '⏸'; kick(); });
    vid.addEventListener('seeked', kick); vid.addEventListener('loadeddata', kick);
    vid.addEventListener('pause', () => { $('#play', el).textContent = '▶︎'; savePos(); });
    vid.addEventListener('click', () => (vid.paused ? vid.play() : vid.pause()));
    rafId = requestAnimationFrame(tick);
  }
  const speed = await getSetting('video.speed', 1);
  if (vid) vid.playbackRate = SPEEDS.includes(speed) ? speed : 1;
  $('#speed', el).textContent = `${vid?.playbackRate || 1}×`;
  // lock screen / earphone controls (Media Session, built into Safari; nothing is sent anywhere)
  const ms = navigator.mediaSession;
  const MS_ACTS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'];
  if (ms && vid) {
    try { ms.metadata = new MediaMetadata({ title: displayName(v.name), artist: 'Englabo', artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] }); } catch {}
    const on = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
    on('play', () => vid.play()); on('pause', () => vid.pause());
    on('previoustrack', () => $('#prevCue', el)?.click()); on('nexttrack', () => $('#nextCue', el)?.click());
    on('seekbackward', () => $('#back', el)?.click()); on('seekforward', () => $('#fwd', el)?.click());
    on('seekto', (d) => { if (d.seekTime != null) vid.currentTime = d.seekTime; });
  }
  setCleanup(() => {
    removeEventListener('resize', fitList); fitRO.disconnect();
    cancelAnimationFrame(rafId); savePos(); vid?.pause(); if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (ms) { for (const a of MS_ACTS) { try { ms.setActionHandler(a, null); } catch {} } try { ms.metadata = null; } catch {} }
  });
}
