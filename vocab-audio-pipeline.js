// 音声付き単語帳の作成パイプライン（Studio / Video Lab / 単語帳 共通）。
// 既存の教材（音声・字幕・照合結果）を読み、項目の抽出 → 確信度 → 局所再照合 → 境界の調整 → 登録 の順に進める。
//  - 各段階は入力の指紋（教材の行・文字起こし・設定）で「済み」を記録する。入力が同じなら再実行しない。
//  - 状態は設定ストア（wap:<kind>:<id>）に残る。中断しても、済んだ段階は保たれ、続きから再開できる。
//  - 手で確定した参照・登録済みの印は、再実行・再照合・再登録で上書きしない。
//  - 自動で走らない: すべて人が開始した操作の中だけで動く。長い段階は分割し、中断の確認を挟む。
import { db, getSetting, setSetting } from './db.js';
import { detectProfile, extractItems, gradeItems, recheckItems, structureRescue, refineRefs, summarize, deriveState, carryOver, confirmRef, clearRef, toRegistration, PROFILES, MODES, keyOf } from './vocab-audio-core.js';
import { planAudioWords, applyAudioWords, refBytes } from './audio-refs.js';

export const recordKey = (kind, id) => `wap:${kind}:${id}`;
const hash = (text) => { let a = 2166136261; for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619); return (a >>> 0).toString(36); };
export const materialFingerprint = (m) => hash(JSON.stringify(m.rows.map(r => [r.id, r.text, r.role || '', r.group || '', r.confirmed ? 1 : 0, r.estimated ? 1 : 0, r.manual ? 1 : 0, (r.segments || []).map(g => [g.key, g.start, g.end]), r.wordTimings ? 1 : 0])));
export const evidenceFingerprint = (m) => hash(JSON.stringify((m.evidence || []).map(e => [e.id, e.text, e.start, e.end])));
const optionsFingerprint = (o) => hash(JSON.stringify([o.profile, o.mode, o.wordList || []]));

// 単語リスト（会話・朗読の対象フレーズ）: 1行に1つ。「フレーズ[タブ/カンマ]意味」でも可。
export function parseWordList(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.split(/\t|,|，|　{2,}/).map(x => x.trim());
    return { head: m[0], ...(m[1] ? { ja: m[1] } : {}) };
  }).filter(x => keyOf(x.head));
}

export async function loadRecord(kind, id) { return getSetting(recordKey(kind, id), null); }
const saveRecord = (rec) => { rec.updatedAt = Date.now(); return setSetting(recordKey(rec.kind, rec.id), rec); };
export const dropRecord = (kind, id) => db.delete('settings', recordKey(kind, id));

export async function loadMaterial(kind, id) {
  const ui = await import('./audio-words-ui.js');
  return kind === 'lab' ? ui.loadLabMaterial(id) : ui.loadStudioMaterial(id);
}

const freshRecord = (kind, id, title) => ({ v: 1, kind, id, title, profile: null, profileSetting: 'auto', mode: 'head', wordList: [], steps: {}, items: [], regions: {}, regionDone: 0, notes: [], updatedAt: 0 });
const yieldNow = () => new Promise(resolve => setTimeout(resolve, 0));

// どの区間の「発話の切れ目」を調べるか: 確認が必要な項目（確定していない・調整を頼む項目）のまわりだけ。長くても40秒ごとの窓に分ける。
export function regionWindows(items, { all = false, pad = 1.5, maxLen = 40, mode = 'head' } = {}) {
  const spans = [];
  for (const it of items) {
    const ri = it.refs[mode === 'sentence' ? 'sentence' : 'word'];
    if (!ri || (ri.tier === 'high' && !all) || ri.manualConfirmed) continue;
    spans.push({ sourceKey: srcKey(ri.ref), src: ri.ref.src, start: Math.max(0, ri.ref.start - pad), end: ri.ref.end + pad });
    for (const c of it.candidates || []) if (c.src) spans.push({ sourceKey: c.sourceKey || srcKey({ src: c.src }), src: c.src, start: Math.max(0, c.start - pad), end: c.end + pad });
  }
  // 見出し語の音声がまだ見つかっていない項目（文字起こしが拾えなかった）は、前後の確定した見出し語のあいだ全体の切れ目を調べる（構造からの救済に使う）
  if (mode !== 'sentence') {
    const hi = ri => ri?.tier === 'high' && ri.ref.state === 'confirmed';
    for (let i = 0; i < items.length; i++) {
      if (hi(items[i].refs.word) || items[i].profile !== 'kinfure') continue;
      let j = i; while (j < items.length && !hi(items[j].refs.word) && items[j].profile === 'kinfure') j++;
      const p = items[i - 1]?.refs.word, n = items[j]?.refs.word;
      if (hi(p) && hi(n) && srcKey(p.ref) === srcKey(n.ref) && n.ref.start > p.ref.end) spans.push({ sourceKey: srcKey(p.ref), src: p.ref.src, start: Math.max(0, p.ref.end - .1), end: n.ref.start + .1, gap: true });
      else if (hi(p)) spans.push({ sourceKey: srcKey(p.ref), src: p.ref.src, start: Math.max(0, p.ref.end - .1), end: p.ref.end + Math.min(40, 6 * (j - i)), gap: true });
      i = j;
    }
  }
  const bySource = new Map();
  for (const s of spans) { if (!bySource.has(s.sourceKey)) bySource.set(s.sourceKey, { src: s.src, list: [] }); bySource.get(s.sourceKey).list.push(s); }
  const out = [];
  for (const [sourceKey, { src, list }] of bySource) {
    list.sort((a, b) => a.start - b.start);
    let cur = null;
    for (const s of list) {
      if (cur && s.start <= cur.end + 2 && s.end - cur.start <= ((s.gap || cur.gap) ? 80 : maxLen)) { cur.end = Math.max(cur.end, s.end); cur.gap ||= s.gap; }   // 構造の救済は、区間が窓の境目で切れないよう長めに取る（窓の上限90秒に収まる80秒まで）
      else { if (cur) out.push(cur); cur = { sourceKey, src, start: s.start, end: s.end, ...(s.gap ? { gap: true } : {}) }; }
    }
    if (cur) out.push(cur);
  }
  return out;
}
const srcKey = (ref) => (ref.src.store === 'studio' ? 'src:' : 'vblobs:') + ref.src.key;
const regionMap = (obj) => new Map(Object.entries(obj || {}));
function mergeRegions(prev, add) {
  const all = [...(prev || []), ...add].sort((a, b) => a[0] - b[0]), out = [];
  for (const r of all) { if (out.length && r[0] <= out.at(-1)[1] + .01) out.at(-1)[1] = Math.max(out.at(-1)[1], r[1]); else out.push([...r]); }
  return out;
}

/**
 * target: { kind: 'lab' | 'studio', id }
 * options: { profile: 'auto' | kinfure | wordlist | dialogue | prose, mode: head | example | sentence, wordList: [{head, ja?}], refine: bool, force: bool }
 * hooks:   { onStep(name, info), cancelled(): bool, regionsFor(src, start, end): Promise<[[s,e]...]> (optional) }
 * 戻り値: { rec, items, summary, reused: [段階名], stopped: bool }
 */
export async function runPipeline(target, options = {}, hooks = {}) {
  const { kind, id } = target, step = (name, info = {}) => hooks.onStep?.(name, info), stop = () => Boolean(hooks.cancelled?.());
  step('load');
  const m = await loadMaterial(kind, id);
  let rec = (await loadRecord(kind, id)) || freshRecord(kind, id, m.title);
  rec.title = m.title;
  const opts = { profile: options.profile ?? rec.profileSetting ?? 'auto', mode: options.mode ?? rec.mode ?? 'head', wordList: options.wordList ?? rec.wordList ?? [] };
  const mfp = materialFingerprint(m), efp = evidenceFingerprint(m), ofp = optionsFingerprint(opts);
  const reused = [];
  const stepOk = (name, fp) => !options.force && rec.steps[name]?.fp === fp;
  const wantRegions = Boolean(hooks.regionsFor) && options.refine !== false;
  const fpDone = `${mfp}|${ofp}|${efp}|${wantRegions ? 'r' : ''}`;
  rec.profileSetting = opts.profile; rec.mode = opts.mode; rec.wordList = opts.wordList;
  // 入力（教材の行・文字起こし・設定）が前回と同じなら、前回の結果をそのまま使う
  if (stepOk('done', fpDone) && rec.items.length && !options.again) { reused.push('extract', 'recheck'); return finish(rec, opts, reused, false); }
  rec.running = { at: Date.now() };
  // 1 判定 + 抽出 + 確信度（軽い処理。再照合は必ずここから作り直す: 前回の結果の上にさらに重ねない）
  step('detect');
  const det = opts.profile === 'auto' || !PROFILES[opts.profile] ? detectProfile(m.rows, { materialType: m.materialType, name: m.title }) : { profile: opts.profile, scores: {}, confidence: 1, reasons: ['手動で指定'], auto: false };
  rec.profile = det.profile; rec.detect = { auto: det.auto, scores: det.scores, confidence: det.confidence, reasons: det.reasons, stats: det.stats };
  step('extract', { profile: det.profile });
  const { items, notes } = extractItems(m.rows, det.profile, { mode: opts.mode, wordList: opts.wordList, from: m.kind, materialId: m.id, title: m.title });
  rec.notes = notes;
  carryOver(rec.items, items, opts.mode);   // 手で確定した参照・登録済みの印・調整の記録は引き継ぐ
  step('grade');
  gradeItems(items, m.rows, { evidence: m.evidence });
  for (const it of items) if (!it.registeredId) it.state = deriveState(it, opts.mode);
  if (stop()) { rec.items = items; return finish(rec, opts, reused, true); }
  // 2 発話の切れ目（任意）。確認が必要な項目のまわりだけを、窓ごとに調べる。窓ごとに保存するので、中断しても続きから。
  if (wantRegions) {
    const regKey = `${mfp}|${ofp}`;
    if (rec.regionFp !== regKey) { rec.regions = {}; rec.regionDone = 0; rec.regionFp = regKey; }
    const wins = regionWindows(items, { all: options.refine === 'all', mode: opts.mode });
    if (rec.regionDone >= wins.length && wins.length) reused.push('regions');
    step('regions', { total: wins.length, done: rec.regionDone });
    for (let i = Math.min(rec.regionDone || 0, wins.length); i < wins.length; i++) {
      if (stop()) { rec.items = items; await saveRecord(rec); return finish(rec, opts, reused, true); }
      const w = wins[i];
      try { const found = await hooks.regionsFor(w.src, w.start, w.end); rec.regions[w.sourceKey] = mergeRegions(rec.regions[w.sourceKey], found || []); } catch { /* この窓は調べられない（形式・大きさ）。境界の判定なしで進む */ }
      rec.regionDone = i + 1;
      step('regions', { total: wins.length, done: i + 1 });
      if ((i + 1) % 5 === 0) await saveRecord(rec);
      await yieldNow();
    }
  }
  const regions = regionMap(rec.regions);
  // 3 局所再照合（確定していない項目だけ。確定済み・手で確定した項目には触れない）
  step('recheck');
  if (regions.size) { gradeItems(items, m.rows, { evidence: m.evidence, regions }); for (const it of items) if (!it.registeredId) it.state = deriveState(it, opts.mode); }   // 発話の境界が分かれば、欠け・混入も判定に入れる
  recheckItems(items, { evidence: m.evidence, regions: regions.size ? regions : null, mode: opts.mode, origin: { from: m.kind, materialId: m.id, title: m.title }, now: Date.now() });
  // 4 構造からの救済（金フレ型）: 文字起こしが見出し語を拾えなかった項目を、確定済みの前後の見出し語と発話区間の並びから特定する。前後が確定していて件数が合うときだけ確定
  if (regions.size) rec.structure = structureRescue(items, { evidence: m.evidence, regions, mode: opts.mode, origin: { from: m.kind, materialId: m.id, title: m.title } }).filter(r => r.outcome !== 'none' || r.why !== 'no-regions');
  if (regions.size) refineRefs(items, regions, { mode: opts.mode });
  for (const it of items) if (!it.registeredId) it.state = deriveState(it, opts.mode);
  rec.items = items;
  rec.steps = { done: { fp: fpDone, at: Date.now() } };
  return finish(rec, opts, reused, false);
}
async function finish(rec, opts, reused, stopped) {
  delete rec.running;
  await saveRecord(rec);
  return { rec, items: rec.items, summary: summarize(rec.items, opts.mode), reused, stopped };
}

// ---- 参照切れ: 録音が見つからない項目（教材や録音が消された・復元で録音が戻っていない） ----
export async function markBroken(rec) {
  const vblobs = new Set(await db.keys('vblobs').catch(() => []));
  const cache = new Map();   // 録音ごとに1回だけ調べる（スタジオの全ファイルを読み込まない）
  let n = 0;
  const exists = async (src) => {
    if (src.store === 'vblobs') return vblobs.has(src.key);
    if (!cache.has(src.key)) {
      const { sdb } = await import('./studio-db.js');
      const s = await sdb.get('sources', src.key);
      cache.set(src.key, Boolean(s && (s.blob || (s.labRef && vblobs.has(s.labRef.videoId ?? s.labRef)))));
    }
    return cache.get(src.key);
  };
  for (const it of rec.items) for (const kind of ['word', 'example', 'sentence']) {
    const ri = it.refs[kind]; if (!ri) continue;
    const ok = await exists(ri.ref.src);
    if (!ok && !ri.broken) { ri.broken = true; n++; } else if (ok && ri.broken) { delete ri.broken; }
    it.state = deriveState(it, rec.mode);
  }
  return n;
}

// ---- 確認画面からの操作（すべて記録に保存。手で確定した参照は以後上書きしない） ----
export async function reviewConfirm(kind, id, key, refKind, range) {
  const rec = await loadRecord(kind, id); if (!rec) throw new Error('作成の記録が見つかりません');
  const it = rec.items.find(x => x.key === key); if (!it) throw new Error('項目が見つかりません');
  confirmRef(it, refKind, range, { mode: rec.mode });
  await saveRecord(rec);
  return rec;
}
export async function reviewClear(kind, id, key, refKind) {
  const rec = await loadRecord(kind, id); if (!rec) throw new Error('作成の記録が見つかりません');
  const it = rec.items.find(x => x.key === key); if (!it) throw new Error('項目が見つかりません');
  clearRef(it, refKind, rec.mode);
  await saveRecord(rec);
  return rec;
}

// ---- 登録 ----
// 確定した音声だけを登録する（標準）。未確定の項目は登録せず、あとでもう一度実行すると、その時点で確定していれば追加される。
// 既存の単語には音声だけを足す（意味・例文・学習記録は変えない）。同じ項目を2回登録しても増えない。
export async function planRegistration(rec, { onlyConfirmed = true, replace = false, addNew = true } = {}) {
  const mode = rec.mode, words = await db.all('words');
  const reg = toRegistration(rec.items, mode);
  const lang = 'en';
  return planAudioWords(reg, words, { mode: addNew ? 'merge' : 'audio', replace, lang, tags: [rec.title], source: rec.kind === 'lab' ? { type: 'video', videoId: rec.id, title: rec.title } : { type: 'studio', setId: rec.id, title: rec.title }, onlyConfirmed, primary: mode === 'sentence' ? 'sentence' : 'word' });
}
export async function registerRecord(kind, id, options = {}) {
  const rec = await loadRecord(kind, id); if (!rec) throw new Error('作成の記録が見つかりません');
  const plan = await planRegistration(rec, options);
  const res = await applyAudioWords(plan);
  for (const it of rec.items) {
    const wordId = res.ids.get(it.key);
    const main = it.refs[rec.mode === 'sentence' ? 'sentence' : 'word'];
    if (wordId && main?.ref.state === 'confirmed') { it.registeredId = wordId; it.state = 'registered'; }
  }
  await saveRecord(rec);
  return { rec, plan, ...res, bytes: refBytes(plan) };
}

// ---- 複数の教材（フォルダ単位）を1つずつ ----
export async function runMany(targets, options = {}, hooks = {}) {
  const out = [];
  for (let i = 0; i < targets.length; i++) {
    if (hooks.cancelled?.()) break;
    hooks.onMaterial?.(i, targets.length, targets[i]);
    try { out.push({ target: targets[i], ...(await runPipeline(targets[i], options, hooks)) }); }
    catch (error) { out.push({ target: targets[i], error: error.message }); }
    await yieldNow();
  }
  return out;
}
export { PROFILES, MODES };

// ---- 診断データ（JSON）: 実機で何が起きたかを、あとから突き合わせられるようにする。音声そのものは含まない（時刻・文字列・判定だけ）。 ----
// 認識文字列と時刻（evidence）、発話区間、項目ごとの割り当て先・確信度・根拠・候補・構造からの救済の結果をまとめる。
export async function buildDiagnostics(kind, id, { maxEvidence = 20000 } = {}) {
  const rec = await loadRecord(kind, id);
  if (!rec) throw new Error('まだ処理されていません。先に「音声付き単語帳を作成」を実行してください');
  const m = await loadMaterial(kind, id);
  const r3 = (t) => Math.round(t * 1000) / 1000;
  const refOut = (ri) => ri ? { source: ri.ref.src.key, store: ri.ref.src.store, start: r3(ri.ref.start), end: r3(ri.ref.end), state: ri.ref.state, tier: ri.tier, score: ri.score, reasons: ri.reasons, manual: Boolean(ri.manualConfirmed || ri.ref.manual), fromStructure: Boolean(ri.fromStructure), fromRecheck: Boolean(ri.fromRecheck), repeats: ri.repeats ?? null, snapped: Boolean(ri.ref.snapped), orig: ri.ref.orig || null } : null;
  const ev = (m.evidence || []).slice(0, maxEvidence);
  return {
    format: 'englabo-vocab-audio-diagnostics', v: 1, createdAt: new Date().toISOString(),
    material: { kind, id, title: rec.title }, profile: rec.profile, profileAuto: rec.detect?.auto ?? null, profileScores: rec.detect?.scores || null, mode: rec.mode,
    summary: summarize(rec.items, rec.mode),
    regions: Object.fromEntries(Object.entries(rec.regions || {}).map(([k, v]) => [k, v.map(([a, z]) => [r3(a), r3(z)])])),
    evidence: ev.map(e => ({ id: e.id, text: e.text, start: r3(e.start), end: r3(e.end), source: e.key, store: e.store, wordTimings: Array.isArray(e.wordTimings) ? e.wordTimings.length : 0 })),
    evidenceTruncated: (m.evidence || []).length > ev.length,
    structure: rec.structure || [],
    items: rec.items.map(it => ({
      order: it.order, head: it.head, example: it.example, state: it.state, registered: Boolean(it.registeredId), issues: it.issues,
      word: refOut(it.refs.word), exampleRef: refOut(it.refs.example), sentence: refOut(it.refs.sentence),
      candidates: (it.candidates || []).map(c => ({ start: c.start, end: c.end, score: c.score, source: c.source, est: Boolean(c.est), text: c.text || null, why: c.why || null })),
      recheck: it.recheck || null, structure: it.structure || null,
    })),
  };
}
