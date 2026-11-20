import { db, STORES, DB_VERSION, setMeta } from './db.js';
import { effLevel } from './mastery.js';

export const APP_ID = 'english-learning-lab';
const EXCLUDE_FIELDS = { videos: ['blob', 'audioBlob'] }; // video files are too large for JSON
const SKIP_STORES = new Set(['vblobs']);   // media files: not in the JSON, and never cleared by a restore

export async function buildBackup() {
  const data = {};
  for (const name of Object.keys(STORES).filter((n) => !SKIP_STORES.has(n))) {
    let rows = await db.all(name);
    const ex = EXCLUDE_FIELDS[name];
    if (ex) rows = rows.map((r) => { const c = { ...r }; ex.forEach((f) => delete c[f]); return c; });
    data[name] = rows;
  }
  return { app: APP_ID, schemaVersion: DB_VERSION, exportedAt: new Date().toISOString(), data };
}

// Returns { ok, errors[], summary{store: count}, backup }
export function validateBackup(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['JSONの形式が正しくありません'] };
  if (obj.app !== APP_ID) errors.push('このアプリのバックアップではありません');
  if (typeof obj.schemaVersion !== 'number') errors.push('schemaVersion がありません');
  else if (obj.schemaVersion > DB_VERSION) errors.push(`新しいバージョン(v${obj.schemaVersion})のバックアップです。アプリを更新してください`);
  if (!obj.data || typeof obj.data !== 'object') errors.push('data がありません');
  const summary = {};
  if (obj.data) {
    for (const [name, rows] of Object.entries(obj.data)) {
      if (!STORES[name]) continue; // unknown stores are ignored
      if (!Array.isArray(rows)) { errors.push(`${name} が配列ではありません`); continue; }
      const kp = STORES[name].keyPath;
      const bad = rows.filter((r) => !r || typeof r !== 'object' || (!STORES[name].autoIncrement && r[kp] == null)).length;
      if (bad) errors.push(`${name}: ${bad}件のデータにIDがありません`);
      summary[name] = rows.length;
    }
  }
  return { ok: errors.length === 0, errors, summary, backup: obj };
}

// Placeholder for future backup-format upgrades (v1 -> v2 ...)
function upgradeBackup(b) { return b; }

export async function restoreBackup(backup) {
  const b = upgradeBackup(backup);
  const names = Object.keys(STORES).filter((n) => !SKIP_STORES.has(n));
  // keep existing video blobs if the same id exists (JSON has no blobs)
  const existingVideos = new Map((await db.all('videos')).map((v) => [v.id, v]));
  await db.tx(names, 'readwrite', (t) => {
    for (const name of names) {
      const os = t.objectStore(name);
      os.clear();
      for (const row of b.data[name] || []) {
        if (name === 'videos' && existingVideos.has(row.id)) { const old = existingVideos.get(row.id); if (old.blob) row.blob = old.blob; if (old.audioBlob) row.audioBlob = old.audioBlob; }   // (older records only; files are in 'vblobs')
        os.put(row);
      }
    }
  });
  // the backup itself proves a backup existed at exportedAt
  const t = Date.parse(b.exportedAt);
  if (!isNaN(t)) await setMeta('lastBackupAt', t);
}

export const STORE_LABELS = { words: '単語', mastery: '習得度', masteryChanges: '習得度の変更履歴', reviews: '復習予定', sessions: '学習セッション', attempts: '回答記録', decks: '単語集', grammar: 'TOEIC問題', listening: 'リスニング問題', speaking: 'スピーキング問題', videos: '動画情報', cues: '字幕', imports: '取り込み履歴', settings: '設定', meta: 'システム情報' };

function csvCell(v) {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join(' / ') : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function wordsCSV() {
  const words = await db.all('words');
  const mastery = await db.all('mastery');
  const reviews = await db.all('reviews');
  const mBy = {}; mastery.forEach((m) => { (mBy[m.wordId] ||= {})[m.skill] = effLevel(m) || ''; });
  const rBy = {}; reviews.forEach((r) => { if (!rBy[r.wordId] || r.due < rBy[r.wordId]) rBy[r.wordId] = r.due; });
  const head = ['headword', 'is_phrase', 'pos', 'meanings', 'example_en', 'example_ja', 'tags', 'bookmarked', 'recognition', 'recall', 'listening', 'spelling', 'next_review', 'source', 'created_at', 'ipa', 'accepted', 'lang', 'gender'];
  const lines = [head.join(',')];
  for (const w of words) {
    const s0 = w.senses?.[0] || {};
    const m = mBy[w.id] || {};
    lines.push([
      w.headword, w.isPhrase ? 1 : 0, s0.pos, (w.senses || []).flatMap((s) => s.meanings || []),
      s0.examples?.[0]?.en, s0.examples?.[0]?.ja, w.tags, w.bookmarked ? 1 : 0,
      m.recognition ?? '', m.recall ?? '', m.listening ?? '', m.spelling ?? '',
      rBy[w.id] ? new Date(rBy[w.id]).toISOString().slice(0, 10) : '', w.source?.type, w.createdAt ? new Date(w.createdAt).toISOString() : '', w.ipa, s0.accepted, w.lang || 'en', s0.gender || '',
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// iPhone: share sheet ("ファイルに保存") if available, otherwise download link
export async function saveFile(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const file = new File([blob], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

export async function exportJSON() {
  const b = await buildBackup();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const r = await saveFile(`ell-backup-${stamp}.json`, JSON.stringify(b), 'application/json');
  if (r !== 'cancelled') await setMeta('lastBackupAt', Date.now());
  return r;
}

export async function exportCSV() {
  const stamp = new Date().toISOString().slice(0, 10);
  return saveFile(`ell-words-${stamp}.csv`, await wordsCSV(), 'text/csv');
}
