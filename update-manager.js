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
export function initUpdate() {
  if (initialized || !navigator.serviceWorker) return;
  initialized = true;
  registration = navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'});
  registration.catch(console.warn);
  const refresh = () => { if (!document.hidden) check().then(r => {
    if (r && r.version !== APP_VERSION) document.title = '更新あり · Englabo';
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
    if (release.version === APP_VERSION && !reg.waiting) { alert(`現在 ${APP_VERSION} / 最新 ${release.version}`); return; }
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
