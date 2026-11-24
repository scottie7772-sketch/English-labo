import { APP_VERSION } from './app-version.js';
let registration, lastCheck = 0, pending, initialized = false;
async function check(force = false) {
  if (!force && Date.now() - lastCheck < 300000) return pending;
  lastCheck = Date.now();
  const r = await fetch('./release.json', {cache:'no-store'});
  if (!r.ok) throw Error('更新情報を取得できません');
  const release = await r.json();
  pending = release;
  return release;
}
// Which release is serving THIS page (the service worker's cache id) vs the newest one on the server.
// The version numbers alone can say "latest" while an older set of files is running; the id is derived from the file hashes.
export function loadedRelease() {
  const sw = navigator.serviceWorker;
  if (!sw?.controller) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); sw.removeEventListener('message', onMessage); resolve(v); };
    const onMessage = (e) => { if (e.data && typeof e.data.release === 'string') done(e.data.release); };
    const timer = setTimeout(() => done(null), 1500);
    sw.addEventListener('message', onMessage);
    try { sw.controller.postMessage('release'); } catch { done(null); }
  });
}
export async function releaseInfo() {
  const [loaded, latest] = await Promise.all([loadedRelease(), check().catch(() => null)]);
  const newest = latest?.id ?? null;
  return { loaded, newest, version: latest?.version ?? null, current: loaded && newest ? loaded === newest : null };
}
export async function releaseLabel() {
  try {
    const i = await releaseInfo();
    if (!i.loaded) return '配信ID：未適用（再起動後に有効）';
    return `配信ID ${i.loaded.slice(0, 6)}${i.current === true ? ' · 最新' : i.current === false ? ' · 更新あり' : ''}`;
  } catch { return ''; }
}
export function initUpdate() {
  if (initialized || !navigator.serviceWorker) return;
  initialized = true;
  registration = navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'});
  registration.catch(console.warn);
  const refresh = () => { if (!document.hidden) check().then(async r => {
    const loaded = await loadedRelease();
    if (r && (r.version !== APP_VERSION || (loaded && r.id && r.id !== loaded))) document.title = '更新あり · Englabo';
  }).catch(()=>{}); };
  refresh(); document.addEventListener('visibilitychange', refresh);
}
function busy() { return !!localStorage.getItem('st-running') || !!document.querySelector('dialog[open]'); }
export async function showUpdate() {
  if (busy()) { alert('処理や編集を終了してから更新してください。'); return; }
  try {
    initUpdate();
    const release = await check(true);
    const reg = await registration;
    if (!reg) throw Error('更新機能を利用できません');
    const loaded = await loadedRelease();
    const same = release.version === APP_VERSION && (!loaded || !release.id || loaded === release.id);
    if (same && !reg.waiting) { alert(`現在 ${APP_VERSION} / 最新 ${release.version}（配信ID ${loaded ? loaded.slice(0, 6) : '未適用'}）`); return; }
    if (!confirm(`現在 ${APP_VERSION} / 最新 ${release.version}\n更新しますか？ 他のEnglabo画面を閉じ、保存を完了してください。教材データは削除しません。`)) return;
    await reg.update();
    let worker = reg.waiting || reg.installing;
    if (worker && worker.state !== 'installed') await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('更新準備がタイムアウトしました')),60000);
      const changed=()=>{if(worker.state==='installed'||worker.state==='activated'){clearTimeout(timer);resolve();}else if(worker.state==='redundant'){clearTimeout(timer);reject(Error('更新ファイルの検証に失敗しました'));}};
      worker.addEventListener('statechange',changed); changed();
    });
    worker=reg.waiting;
    if (busy()) throw Error('処理中のため更新を延期しました');
    if (!worker) throw Error('更新準備中です。他の画面を閉じて再確認してください');
    // Do not force activation while another client may be editing. Normal lifecycle activates after all clients close.
    alert('更新の準備が完了しました。Englaboとスタジオの全画面を完全に閉じてから開き直してください。');
  } catch(e) { alert('更新できませんでした：'+e.message+'。保存データは変更していません。'); }
}
