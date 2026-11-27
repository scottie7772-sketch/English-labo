// 1.19.31: screens for word-card audio (references to existing recordings; nothing is copied).
import { db } from './db.js';
import { readVideoJa, videoJaView, compareVideoCues } from './video-ja.js';
import { labRows, studioRows, labEvidence, studioEvidence, pickReading, limitsFor, makeRef, studioConfirmed,
  referencedMedia, unusedRecordings, refBlob, sameText, usableRef } from './audio-refs.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n = 50) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
const fmtT = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const toast = (text, ms = 3000) => { const t = document.getElementById('toast'); if (!t) return; t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); };
const pause = () => new Promise(r => setTimeout(r, 60));
function sheet(title, body, buttons) {
  const dlg = document.getElementById('dialog');
  if (dlg.open) { dlg.onclose = null; dlg.close(); }
  dlg.innerHTML = `<form method="dialog" class="dlg stack jp-sheet"><span class="dlg-global-close" hidden></span><h3>${esc(title)}</h3>${body}
    <div class="jp-grid">${buttons.map(([v, l, c = '']) => `<button class="btn sm ${c}" value="${v}">${esc(l)}</button>`).join('')}</div></form>`;
  dlg.returnValue = '';
  return new Promise(resolve => { dlg.onclose = () => resolve({ value: dlg.returnValue, dlg }); dlg.showModal(); });
}

// ---------- loading one material as rows (text and times only; the recordings are not read) ----------
const scriptOrder = cues => cues.some(c => c.studioOrder != null) ? cues.slice().sort((a, b) => (a.studioOrder ?? Infinity) - (b.studioOrder ?? Infinity) || compareVideoCues(a, b)) : cues.slice().sort(compareVideoCues);
async function vblobSize(key) { try { const r = await db.get('vblobs', key); return r?.size || r?.blob?.size || null; } catch { return null; } }
export async function loadLabMaterial(videoId) {
  const video = await db.get('videos', videoId);
  if (!video) throw new Error('教材が見つかりません');
  const { blob, audioBlob, ...meta } = video;
  const cues = scriptOrder(await db.byIndex('cues', 'videoId', videoId));
  const parts = new Map(), sizes = new Map();
  for (const p of meta.parts || []) { const child = await db.get('videos', p.videoId); if (child) { const { blob: b1, audioBlob: b2, ...c } = child; parts.set(p.videoId, c); } }
  for (const v of [meta, ...parts.values()]) { const key = v.mediaRef || v.id; if (!sizes.has(key)) sizes.set(key, await vblobSize(key)); }
  let studio = null;
  if (meta.from?.material) try {
    const { sdb, liveBlocks } = await import('./studio-db.js');
    const set = await sdb.get('sets', meta.from.material);
    if (set) studio = new Map((await liveBlocks(set)).map(b => [b.id, b]));
  } catch { /* no Studio data on this device */ }
  const view = videoJaView(cues, await readVideoJa(videoId));
  const rows = labRows(meta, cues, { parts, sizes, studio, jaOf: c => view.get(c) });
  return { kind: 'lab', id: videoId, title: meta.name, lang: meta.lang || 'en', folder: meta.folder || '', materialType: meta.materialType || '', vocab: cues.some(c => c.studySet && c.role), rows, evidence: labEvidence(meta, cues, { sizes }), video: meta, cues };
}
export async function loadStudioMaterial(setId) {
  const { sdb, liveBlocks } = await import('./studio-db.js');
  const { isVocabHead } = await import('./studio-vocab-align.js');
  const { studioJaView } = await import('./studio-ja.js');
  const set = await sdb.get('sets', setId);
  if (!set) throw new Error('教材が見つかりません');
  const blocks = await liveBlocks(set), sources = {};
  for (const id of new Set(blocks.flatMap(b => b.segments.map(g => g.sourceId)))) {
    const s = await sdb.get('sources', id);
    if (s) { const { blob, ...meta } = s; sources[id] = { ...meta, size: s.size || blob?.size || null }; }
  }
  // the Lab copy of a Studio recording (made when the material was sent to the Lab) is preferred: it is in the backup scope
  const labVideos = Object.values(sources).some(s => !s.labRef) ? await db.all('videos') : [];
  for (const s of Object.values(sources)) if (!s.labRef) {
    const lab = labVideos.find(v => v.from?.media === s.id && v.kind !== 'multi');
    if (lab) { const key = lab.mediaRef || lab.id, size = await vblobSize(key); if (size && (!s.size || size === s.size)) s.labRef = { videoId: key }; }
  }
  const view = studioJaView(blocks);
  // roles (見出し語 / 例文) only for a material that declares them; for the others the structure is read from the text
  const explicitRoles = set.materialType === 'vocab' || blocks.some(b => b.kind === 'word' || b.kind === 'example');
  const rows = studioRows(blocks, sources, { isHead: isVocabHead, jaOf: b => view.value(b), explicitRoles });
  return { kind: 'studio', id: setId, title: set.title, lang: 'en', folder: set.folder || '', materialType: set.materialType || '', vocab: set.materialType === 'vocab', rows, evidence: studioEvidence(blocks, sources), set };
}
// ================= 音声付き単語帳を作成（入口は1つ: vocab-audio-wizard.js） =================
// 以前の「金フレ型の一括登録」の画面はここで終わり。判定・照合・確認・登録は共通のパイプラインで行う。
export async function openAudioWordBulk(target, { folder = false } = {}) {
  const wizard = await import('./vocab-audio-wizard.js');
  const targets = folder ? await wizard.folderTargets(target) : [{ kind: target.kind, id: target.id }];
  return wizard.openVocabAudioWizard({ targets, folder });
}

// ================= Video Lab: audio for one word registered from a subtitle =================
// Word sound: only from a word line (金フレ見出し語) or a line that is exactly the word — never the whole sentence.
export function labCueAudioOptions(video, cues, cue, { parts = new Map() } = {}) {
  const rows = labRows(video, cues, { parts });
  const row = rows.find(r => r.id === cue.id); if (!row) return { word: null, example: null };
  const wordRow = row.role === 'word' ? row : row.group ? rows.find(r => r.group === row.group && r.role === 'word') : null;
  const exRow = row.role !== 'word' ? row : row.group ? rows.find(r => r.group === row.group && r.role === 'example') : null;
  const all = rows.flatMap(r => r.segments);
  const ref = (r, kind) => {
    const p = pickReading(r.segments); if (!p) return null;
    return makeRef({ store: p.seg.store, key: p.seg.key, size: p.seg.size, start: p.seg.start, end: p.seg.end, limit: limitsFor(p.seg, all),
      origin: { from: 'lab', materialId: video.id, cueId: r.id, ...(r.itemId ? { itemId: r.itemId } : {}), text: r.text, title: video.name },
      state: r.confirmed && !p.unsure ? 'confirmed' : 'unconfirmed' });
  };
  return { word: wordRow ? { ref: ref(wordRow, 'word'), text: wordRow.text } : null,
    example: exRow ? { ref: ref(exRow, 'example'), text: exRow.text } : null };
}
// HTML + events for the 字幕から単語を登録 dialog. getHead() = the headword being registered.
export function cueAudioSection(dlg, opts, getHead) {
  const st = { word: opts.word?.ref ? { ...opts.word.ref } : null, example: opts.example?.ref ? { ...opts.example.ref } : null, heard: new Set() };
  const html = `<fieldset class="wa-box small"><legend>音声（元の録音の区間を参照・コピーしません）</legend>
    ${['word', 'example'].map(kind => {
      const o = opts[kind], label = kind === 'word' ? '単語の音声' : '例文の音声';
      if (!o?.ref) return `<div class="muted">${label}：${kind === 'word' ? '単語だけの音声がありません（文の音声は単語として登録しません）' : 'この字幕に音声がありません'}</div>`;
      return `<div class="wa-row"><label class="chk grow"><input type="checkbox" data-wa-use="${kind}" ${kind === 'example' || o.ref.state === 'confirmed' ? 'checked' : ''}> ${label}：${esc(clip(o.text, 40))}</label>
        <span class="wa-tag ${o.ref.state === 'confirmed' ? '' : 'warn'}" data-wa-state="${kind}">${o.ref.state === 'confirmed' ? '確定' : '未確定'}</span></div>
        <div class="wa-grid"><button type="button" class="btn sm" data-wa-play="${kind}">▶ 試聴</button><button type="button" class="btn sm" data-wa-adj="${kind}:start:-0.05">開始−</button><button type="button" class="btn sm" data-wa-adj="${kind}:start:0.05">開始＋</button><button type="button" class="btn sm" data-wa-adj="${kind}:end:0.05">終了＋</button></div>
        <div class="wa-grid"><span class="small muted" data-wa-time="${kind}">${fmtT(o.ref.start)}〜${fmtT(o.ref.end)}</span><span></span><span></span><button type="button" class="btn sm" data-wa-adj="${kind}:end:-0.05">終了−</button></div>`;
    }).join('')}
    <p class="muted">試聴して確かめた音声は「確定」として登録します。字幕・音声ファイル・再生時刻は変わりません。</p></fieldset>`;
  // the word sound is offered only while the headword being registered is that word line
  const follow = () => {
    const box = dlg.querySelector('[data-wa-use="word"]'); if (!box || !opts.word) return;
    const ok = sameText(opts.word.text, getHead());
    box.disabled = !ok; if (!ok) box.checked = false; else if (!box.dataset.touched) box.checked = opts.word.ref?.state === 'confirmed';
  };
  const bind = () => {
    const ac = new AbortController();   // the dialog element is shared: the listeners end with this dialog
    dlg.addEventListener('close', () => ac.abort(), { once: true });
    dlg.addEventListener('input', () => setTimeout(follow, 0), { signal: ac.signal });
    dlg.addEventListener('click', e => { if (e.target.matches?.('[data-wa-use="word"]')) e.target.dataset.touched = '1'; setTimeout(follow, 0); }, { signal: ac.signal });
    setTimeout(follow, 0);
    dlg.querySelectorAll('[data-wa-play]').forEach(b => b.onclick = async () => {
      const kind = b.dataset.waPlay, ref = st[kind]; if (!ref) return;
      const m = await import('./word-audio.js');
      if (await m.playRef(ref)) { st.heard.add(kind); }
      else toast('録音が見つかりません');
    });
    dlg.querySelectorAll('[data-wa-adj]').forEach(b => b.onclick = () => {
      const [kind, edge, d] = b.dataset.waAdj.split(':'), ref = st[kind]; if (!ref) return;
      const v = Math.round((ref[edge] + Number(d)) * 1000) / 1000;
      if (edge === 'start' ? v < 0 || v >= ref.end - 0.1 : v <= ref.start + 0.1) return;
      ref[edge] = v; st.heard.delete(kind);
      const t = dlg.querySelector(`[data-wa-time="${kind}"]`); if (t) t.textContent = `${fmtT(ref.start)}〜${fmtT(ref.end)}`;
    });
  };
  // result: { word?: ref, example?: ref } for the checked kinds (a previewed sound counts as checked by the user)
  const result = () => {
    const out = {};
    for (const kind of ['word', 'example']) {
      if (!st[kind] || !dlg.querySelector(`[data-wa-use="${kind}"]`)?.checked) continue;
      if (kind === 'word' && opts.word && !sameText(opts.word.text, getHead())) continue;   // the word line must be this headword
      const heard = st.heard.has(kind);
      out[kind] = { ...st[kind], state: heard || st[kind].state === 'confirmed' ? 'confirmed' : 'unconfirmed', at: Date.now(), ...(heard ? { manual: true } : {}) };
    }
    return out;
  };
  return { html, bind, result };
}

// ================= word detail: the word's sounds =================
export function wordAudioHTML(w) {
  const a = w.audio || {};
  if (!a.word && !a.example && !a.sentence) return '';
  const LABEL = { word: '単語', example: '例文', sentence: '文全体' };
  const row = kind => {
    const ref = a[kind]; if (!ref) return '';
    return `<div class="wa-row"><b>${LABEL[kind]}</b>${ref.manual ? '<span class="wa-tag">手で確定</span>' : ''}<span class="wa-tag ${ref.state === 'confirmed' ? '' : 'warn'}">${ref.state === 'confirmed' ? '確定' : '未確定'}</span>
      <span class="grow small muted">${esc(clip(ref.origin?.title || '', 30))}・${fmtT(ref.start)}〜${fmtT(ref.end)}${kind !== 'word' ? `<br>${esc(clip(ref.origin?.text, 60))}` : ''}</span></div>
      <div class="wa-grid"><button type="button" class="btn sm" data-wad-play="${kind}">▶ 再生</button><button type="button" class="btn sm" data-wad-adj="${kind}:start:-0.05">開始−</button><button type="button" class="btn sm" data-wad-adj="${kind}:start:0.05">開始＋</button><button type="button" class="btn sm" data-wad-adj="${kind}:end:-0.05">終了−</button>
        <button type="button" class="btn sm" data-wad-adj="${kind}:end:0.05">終了＋</button>${ref.state === 'confirmed' ? '<span></span>' : `<button type="button" class="btn sm" data-wad-ok="${kind}">確定にする</button>`}<span></span><button type="button" class="btn sm ghost" data-wad-del="${kind}">参照を外す</button></div>`;
  };
  return `<h2 class="sec">音声</h2><div class="card wa-box">${row('word')}${row('example')}${row('sentence')}
    <p class="hint">元の録音の区間を参照しています（音声はコピーしていません）。参照を外しても録音や教材は消えません。差し替えは動画ラボの字幕「＋語」から登録し直します。</p></div>`;
}
export function bindWordAudio(root, wordId, redraw) {
  const update = async fn => {
    const w = await db.get('words', wordId); if (!w) return;
    const audio = { ...(w.audio || {}) };
    if (fn(audio) === false) return;
    for (const k of ['word', 'example', 'sentence']) if (!audio[k]) delete audio[k];
    await db.put('words', { ...w, audio, updatedAt: Date.now() });
    redraw();
  };
  root.querySelectorAll('[data-wad-play]').forEach(b => b.onclick = async () => {
    const w = await db.get('words', wordId), ref = w?.audio?.[b.dataset.wadPlay];
    const m = await import('./word-audio.js');
    if (!ref || !(await m.playRef(ref))) toast('録音が見つかりません（教材や音声が削除された可能性）');
  });
  root.querySelectorAll('[data-wad-adj]').forEach(b => b.onclick = () => update(a => {
    const [kind, edge, d] = b.dataset.wadAdj.split(':'), ref = a[kind]; if (!ref) return false;
    const v = Math.round((ref[edge] + Number(d)) * 1000) / 1000;
    if (edge === 'start' ? v < 0 || v >= ref.end - 0.1 : v <= ref.start + 0.1) return false;
    a[kind] = { ...ref, [edge]: v, state: 'unconfirmed', manual: true };   // a moved range is checked again (▶ then 確定にする); a person's edit is never replaced by a re-registration
  }));
  root.querySelectorAll('[data-wad-ok]').forEach(b => b.onclick = () => update(a => { a[b.dataset.wadOk] = { ...a[b.dataset.wadOk], state: 'confirmed', manual: true }; }));
  root.querySelectorAll('[data-wad-del]').forEach(b => b.onclick = () => update(a => { delete a[b.dataset.wadDel]; }));
}

// ================= storage: recordings used by word cards =================
export async function storageAudioHTML() {
  const words = await db.all('words');
  const refs = await referencedMedia(words);
  const withAudio = words.filter(w => w.audio?.word || w.audio?.example || w.audio?.sentence).length;
  const studioOnly = new Set(words.flatMap(w => ['word', 'example', 'sentence'].map(k => w.audio?.[k]).filter(r => r?.src?.store === 'studio').map(r => w.id))).size;
  const { kept, unused } = await unusedRecordings();
  let broken = 0;
  for (const w of words) for (const k of ['word', 'example', 'sentence']) { const r = w.audio?.[k]; if (r?.src?.store === 'vblobs' && !(await db.get('vblobs', r.src.key))) broken++; }
  let keptSize = 0, unusedSize = 0;
  for (const k of kept) keptSize += await vblobSize(k) || 0;
  for (const k of unused) unusedSize += await vblobSize(k) || 0;
  return `<h2 class="sec">単語帳の音声</h2><div class="card stack small">
    <div>音声付きの単語：${withAudio}語（参照している録音 ${refs.vblobs.size + refs.studio.size}件。音声は教材の録音を共有し、単語ごとに複製していません）</div>
    <div>教材を削除した後も単語帳のために残している録音：${kept.length}件・${fmtSize(keptSize)}</div>
    <div>どの教材・単語にも使われていない録音：${unused.length}件・${fmtSize(unusedSize)} ${unused.length ? '<button class="btn sm" id="waDelUnused">削除</button>' : ''}</div>
    ${broken ? `<div>録音が見つからない参照：${broken}件（カードでは音声なしとして扱います） <button class="btn sm" id="waDropBroken">参照を外す</button></div>` : ''}
    ${studioOnly ? `<div class="warn-text">${studioOnly}語の音声は、スタジオだけにある録音を参照しています。バックアップには入りません（教材をVideo Labに送ると、録音がバックアップの対象になります）。</div>` : ''}
    ${kept.length ? '<div class="muted">単語帳のために残している録音は、その単語の「参照を外す」か単語を削除すると、ここで削除できるようになります。</div>' : ''}</div>`;
}
export function bindStorageAudio(root, redraw) {
  root.querySelector('#waDelUnused')?.addEventListener('click', async () => {
    const { unused } = await unusedRecordings();
    if (!unused.length) return redraw();
    if (!confirm(`どこからも使われていない録音 ${unused.length}件を削除します`)) return;
    const { releaseLabRefs } = await import('./studio-db.js');
    await releaseLabRefs(unused);   // the Studio keeps its own copy if it still points to one of them
    await db.tx(['vblobs'], 'readwrite', t => { for (const k of unused) t.objectStore('vblobs').delete(k); });
    toast('削除しました'); redraw();
  });
  root.querySelector('#waDropBroken')?.addEventListener('click', async () => {
    let n = 0;
    for (const w of await db.all('words')) {
      if (!w.audio) continue;
      const a = { ...w.audio };
      for (const k of ['word', 'example', 'sentence']) if (a[k]?.src?.store === 'vblobs' && !(await db.get('vblobs', a[k].src.key))) { delete a[k]; n++; }
      if (n && JSON.stringify(a) !== JSON.stringify(w.audio)) await db.put('words', { ...w, audio: a });
    }
    toast(`${n}件の参照を外しました`); redraw();
  });
}
export { usableRef, refBlob, studioConfirmed };
