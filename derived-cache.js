// 解析の途中結果・キャッシュ（作り直せるもの）の一覧と、一括削除。
// 消すのは「作り直せる派生データ」だけ。取り込んだ音声・動画、字幕・スクリプトの行、手動で直した内容、保存した版、
// 全体スクリプト、単語帳の単語・学習記録は消えない。消したあとに同じ操作をすると、途中結果は最初から作り直される。

const fmt = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const sizeOf = (v) => { try { return JSON.stringify(v).length; } catch { return 0; } };

export const CATEGORIES = [
  { id: 'edge', label: '音声の先頭・末尾の文字起こし', note: 'スクリプト範囲の推定に使った文字起こし' },
  { id: 'saCkpt', label: '無音の構造で割り当ての途中結果', note: '発話区間・例文の文字起こし（中断後の再開に使うもの）' },
  { id: 'speechFirst', label: '発話区切り照合の途中結果・候補', note: '解析の途中結果と、未保存の照合候補' },
  { id: 'receipts', label: '照合の受付記録', note: '直前の照合結果の確認用の記録（行の内容は変わりません）' },
  { id: 'vocabRecords', label: '音声付き単語帳の作成の途中結果', note: '項目・確信度・候補。登録済みの単語と音声参照は消えません' },
  { id: 'regionCache', label: '発話区間のキャッシュ（再生位置の補正用）', note: '次に再生するとき自動で作り直します' },
  { id: 'history', label: '↶で戻せる操作の履歴（すべて）', note: '消すと↶で戻せなくなります。保存した版は残ります', optIn: true },
];

// 各データベースを開く（使えない環境では、その分類は 0 件として扱う）
async function stores() {
  let sdb = null, db = null;
  try { sdb = (await import('./studio-db.js')).sdb; } catch { /* 教材スタジオが無い */ }
  try { db = (await import('./db.js')).db; } catch { /* 英語ラボ側のデータベースが無い */ }
  return { sdb, db };
}
const metaKind = (key) => (/^edge-cues:/.test(key) ? 'edge' : /^sa-ckpt:/.test(key) ? 'saCkpt' : /^speech-first:/.test(key) ? 'speechFirst' : null);

export async function scanDerived() {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c.id, { count: 0, bytes: 0 }]));
  const { sdb, db } = await stores();
  const add = (id, v) => { out[id].count++; out[id].bytes += sizeOf(v); };
  if (sdb) {
    for (const m of await sdb.all('meta').catch(() => [])) { const k = metaKind(String(m.key || '')); if (k) add(k, m); }
    for (const st of await sdb.all('sets').catch(() => [])) {
      if (st.speechFirstDraft?.length) add('speechFirst', st.speechFirstDraft);
      if (st.structureAlignReceipt) add('receipts', st.structureAlignReceipt);
      if (st.undo?.length || st.redo?.length) add('history', [...(st.undo || []), ...(st.redo || [])]);
    }
  }
  if (db) for (const r of await db.all('settings').catch(() => [])) if (/^wap:/.test(String(r.key || ''))) add('vocabRecords', r);
  try { const raw = localStorage.getItem('wa-parts1'); if (raw) { out.regionCache.count = Object.keys(JSON.parse(raw)).length; out.regionCache.bytes = raw.length; } } catch { /* 読めない */ }
  return out;
}

export async function clearDerived(ids) {
  const want = new Set(ids), done = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  const { sdb, db } = await stores();
  if (sdb) {
    for (const m of await sdb.all('meta').catch(() => [])) { const k = metaKind(String(m.key || '')); if (k && want.has(k)) { await sdb.del('meta', m.key); done[k]++; } }
    for (const st of await sdb.all('sets').catch(() => [])) {
      let changed = false; const next = { ...st };
      if (want.has('speechFirst') && st.speechFirstDraft) { delete next.speechFirstDraft; changed = true; done.speechFirst++; }
      if (want.has('receipts') && st.structureAlignReceipt) { delete next.structureAlignReceipt; changed = true; done.receipts++; }
      if (want.has('history') && (st.undo?.length || st.redo?.length)) { next.undo = []; next.redo = []; changed = true; done.history++; }
      if (changed) await sdb.put('sets', next);
    }
    if (want.has('history')) {
      // どの教材からも参照されない操作・過去の状態だけを消す（保存した版が使う過去の状態は残す）
      const keepRevs = new Set();
      for (const st of await sdb.all('sets')) {
        for (const b of await sdb.byIndex('blocks', 'setId', st.id)) keepRevs.add(`${b.id}@${b.rev}`);
        for (const v of await sdb.byIndex('versions', 'setId', st.id)) Object.values(v.revs || {}).forEach((r) => keepRevs.add(r));
      }
      for (const o of await sdb.all('oplog')) await sdb.del('oplog', o.id);
      for (const r of await sdb.all('blockRevs')) if (!keepRevs.has(r.id)) await sdb.del('blockRevs', r.id);
    }
  }
  if (db && want.has('vocabRecords')) for (const r of await db.all('settings').catch(() => [])) if (/^wap:/.test(String(r.key || ''))) { await db.delete('settings', r.key); done.vocabRecords++; }
  if (want.has('regionCache')) { try { const raw = localStorage.getItem('wa-parts1'); if (raw) done.regionCache = Object.keys(JSON.parse(raw)).length; localStorage.removeItem('wa-parts1'); } catch { /* 消せない */ } }
  return done;
}

// 一覧と確認の画面。onDone は削除のあとに呼ぶ（画面の再描画など）
export async function openDerivedCacheDialog({ onDone = null } = {}) {
  const { $, esc, toast, confirmDialog } = await import('./ui.js');
  const scan = await scanDerived();
  const rows = CATEGORIES.map((c) => ({ ...c, ...scan[c.id] }));
  const total = rows.filter((r) => !r.optIn).reduce((n, r) => n + r.count, 0);
  const body = `<p class="small">作り直せる解析データだけを消します。<b>音声・動画、字幕・スクリプトの行、手動の修正、保存した版、全体スクリプト、単語帳の単語・学習記録は消えません。</b>消したあとに同じ操作をすると、途中結果は最初から作り直されます。</p>
    <div class="stack" id="dcList">${rows.map((r) => `<label class="row"><input type="checkbox" data-dc="${r.id}" ${r.optIn || !r.count ? '' : 'checked'} ${r.count ? '' : 'disabled'}> <span class="grow"><b>${esc(r.label)}</b>　<span class="small muted">${r.count}件・${fmt(r.bytes)}</span><br><small class="muted">${esc(r.note)}</small></span></label>`).join('')}</div>`;
  const ok = await new Promise((resolve) => {
    const dlg = $('#dialog'); if (dlg.open) { dlg.onclose = null; dlg.close(); }
    setTimeout(() => {
      dlg.innerHTML = `<form method="dialog" class="dlg stack"><h3>解析データ・キャッシュの一括削除</h3>${body}<div class="row end"><button class="btn ghost" value="cancel">閉じる</button><button class="btn danger" value="go" ${total || rows.some((r) => r.optIn && r.count) ? '' : 'disabled'}>チェックしたものを削除</button></div></form>`;
      dlg.returnValue = '';
      dlg.onclose = () => resolve(dlg.returnValue === 'go' ? [...dlg.querySelectorAll('[data-dc]:checked')].map((x) => x.dataset.dc) : null);
      dlg.showModal();
    }, 60);
  });
  if (!ok?.length) return null;
  if (ok.includes('history') && !(await confirmDialog({ title: '↶の履歴をすべて消しますか', body: '<p>これまでの編集を↶で戻せなくなります。教材の内容と、保存した版は変わりません。</p>', okLabel: '消す', danger: true }))) return null;
  const done = await clearDerived(ok);
  const n = Object.values(done).reduce((a, b) => a + b, 0);
  toast(`削除しました（${n}件）`, 4000);
  onDone?.(done);
  return done;
}
