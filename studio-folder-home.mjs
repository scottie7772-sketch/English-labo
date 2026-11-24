import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

const node = () => ({ addEventListener() {}, focus() {}, select() {} });
function view() {
  const ids = new Map(), rows = [];
  return {
    get innerHTML() { return this.html; },
    set innerHTML(html) {
      this.html = html;
      ids.clear();
      rows.length = 0;
      for (const [, id] of html.matchAll(/ id="([^"]+)"/g)) ids.set('#' + id, node());
      for (const [, id] of html.matchAll(/ data-folder-row="([^"]+)"/g)) {
        const children = { '.st-folderlink':node(), '.st-foldermenu':node() };
        rows.push({ dataset:{folderRow:id}, querySelector: key => children[key] });
      }
    },
    querySelector: key => ids.get(key),
    querySelectorAll: key => key === '[data-folder-row]' ? rows : [],
    contains: item => [...ids.values()].includes(item),
  };
}
const root = view(), dialog = view(), messages = node();
dialog.showModal = () => { assert.ok(!dialog.open); dialog.open = true; };
dialog.close = result => {
  assert.ok(dialog.open);
  if (result) dialog.returnValue = result;
  dialog.open = false;
  const onclose = dialog.onclose;
  queueMicrotask(() => onclose?.());
};
globalThis.window = globalThis;
globalThis.location = { hash:'#studio/sets' };
globalThis.localStorage = { getItem() { return null; } };
globalThis.addEventListener = () => {};
globalThis.scrollTo = () => {};
globalThis.document = { addEventListener() {}, querySelector: key => ({ '#dialog':dialog, '#toast':messages }[key]) };

const { sdb } = await import('../studio-db.js');
const order = ['seen','fail','ok'];
const sets = [...order, 'unrelated'].map((id, index) => ({
  id, title:id, folder:id === 'unrelated' ? 'Other' : 'Old', updatedAt:index,
  sourceId:'audio', order:[id + '-caption'], undo:[],
}));
const captions = sets.map(set => ({
  id:set.order[0], setId:set.id, rev:2, aligned:true, text:'Example ' + set.id,
  ja:'訳', jaReview:true, jaStatus:'needsReview', sync:'estimated', segments:[{sourceId:'audio',start:1,end:2}],
}));
const registry = { key:'studio-folders', folders:[{id:'folder-ma',name:'Old',order}, {id:'folder-other',name:'Other',order:['unrelated']}] };
const corpus = { key:'studio-folder-ja:folder-ma', sections:[{name:'one.json',data:{items:[{en:'Example',ja:'例'}]}}] };
const source = { id:'audio', name:'Audio', kind:'video', size:4, duration:6, stored:true, blob:new Blob(['fake']) };
const data = structuredClone({ sets, blocks:captions, sources:[source], meta:[registry,corpus] });
sdb.all = async store => structuredClone(data[store]);
sdb.get = async (store,id) => structuredClone(data[store].find(row => (row.id ?? row.key) === id));
sdb.byIndex = async (store,key,value) => structuredClone(data[store].filter(row => row[key] === value));
sdb.tx = async (stores,mode,operation) => {
  const request = result => {
    const r = { result:structuredClone(result) };
    queueMicrotask(() => r.onsuccess?.());
    return r;
  };
  operation({ objectStore:store => ({
    get:key => request(data[store].find(row => row.key === key)),
    getAll:() => request(data[store]),
    put:row => { data[store][data[store].findIndex(old => (old.id ?? old.key) === (row.id ?? row.key))] = structuredClone(row); },
  }) });
  await wait(0);
};
const imported = new Set(['seen']), sent = [], sync = [];
let active = 0, failOnce = true;
const host = {
  studioLabState: async () => new Set(imported),
  syncStudioLabFolder: async (name,ids) => { sync.push([name,ids]); },
  async sendToLab(manifest, material, loadMedia, options) {
    assert.equal(active++, 0);
    const id = manifest.materialId;
    sent.push([id, dialog.querySelector('#stLabProgress').textContent]);
    assert.equal(options.update,false);
    assert.equal(material.set.folder,'New & updated');
    assert.equal(material.set.folderOrder,order.indexOf(id));
    assert.equal(material.items[0].text,'Example ' + id);
    assert.equal(material.items[0].ja,'訳');
    assert.deepEqual(material.items[0].segments,[{media:'audio',start:1,end:2}]);
    assert.equal(loadMedia(material.media[0]).size,4);
    await wait(0);
    active--;
    if (id === 'fail' && failOnce) { failOnce = false; throw Error('Temporary failure'); }
    imported.add(id);
    return {id:'video-' + id};
  },
};
const { mount } = await import('../studio-main.js');
mount(root,{base:'studio/',host});
await wait(0);
async function waitForDialog(pattern) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (dialog.open && pattern.test(dialog.innerHTML)) return;
    await wait(10);
  }
  assert.fail(`Dialog did not contain ${pattern}`);
}
const row = () => root.querySelectorAll('[data-folder-row]').find(item => item.dataset.folderRow === 'folder-ma');
const link = row().querySelector('.st-folderlink');
link.onpointerdown({isPrimary:true,button:0,clientX:10,clientY:10});
await wait(570);
assert.match(dialog.innerHTML, /フォルダ名を変更/);
let navigationPrevented = false;
link.onclick({ detail:1, preventDefault:() => { navigationPrevented = true; } });
assert.equal(navigationPrevented,true);
dialog.close('rename');
await wait(0);
dialog.querySelector('#askT').value = 'New & updated';
dialog.close('ok');
await wait(5);
assert.match(root.innerHTML,/New &amp; updated/);
assert.match(root.innerHTML,/href="#studio\/sets\?folder=folder-ma"/);
assert.equal(location.hash,'#studio/sets');
assert.deepEqual(data.meta[0].folders[0], {id:'folder-ma',name:'New & updated',order});
assert.deepEqual(data.meta[1],corpus);
assert.deepEqual(data.blocks,captions);
assert.deepEqual(data.sets.slice(0,3),sets.slice(0,3).map(set => ({...set,folder:'New & updated'})));
assert.deepEqual(sync,[]);

const batch = row().querySelector('.st-foldermenu').onclick();
assert.match(dialog.innerHTML,/一括教材化/);
assert.match(dialog.innerHTML,/value="folderPack"/);   // 1.19.35: ZIP export is offered inside Englabo too, not only in the standalone Studio
dialog.close('lab');
await wait(0);
assert.match(dialog.innerHTML,/新しく追加 2件/);   // 1.19.28: the registered one is not sent again
assert.match(dialog.innerHTML,/登録済み 1件/);
dialog.close('start');
await waitForDialog(/成功 1件・失敗 1件・スキップ 0件/);
dialog.close('retry');
await waitForDialog(/成功 1件・失敗 0件・スキップ 0件/);
dialog.close('close');
await batch;
assert.deepEqual(sync,[['New & updated',order]]);
assert.deepEqual(sent,[['fail','1 / 2　fail'],['ok','2 / 2　ok'],['fail','1 / 1　fail']]);
assert.equal(location.hash,'#studio/sets');
location.hash = '#sets';
mount(root);
await wait(0);
const exportFlow = row().querySelector('.st-foldermenu').onclick();
assert.match(dialog.innerHTML,/一括教材化（ZIPで書き出す）/);
const opening = URL.createObjectURL;
let packaged;
URL.createObjectURL = file => { packaged = file; return opening(file); };
dialog.close('folderPack');
await waitForDialog(/含める内容/);
dialog.close('start');
await waitForDialog(/教材 3件・音声付き/);
URL.createObjectURL = opening;
assert.equal(packaged.name,'New & updated-一括教材.elpack.zip');
const { readMaterialImport } = await import('../material-pack.js');
const collection = await readMaterialImport(packaged);
assert.equal(collection.title,'New & updated');
assert.deepEqual(collection.entries.map(entry => entry.title),order);
for (const [rank, entry] of collection.entries.entries()) {
  const { material, getFile } = await entry.read();
  assert.equal(material.set.folderOrder,rank);
  assert.equal(material.set.packId,'folder-ma');   // 1.19.28: the folder tag survives any import order
  assert.equal(material.set.contents,'both');
  assert.equal(material.items[0].ja,'訳');
  assert.equal(await (await getFile(material.media[0])).text(),'fake');
}
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const timer = schedule(fn, ms, ...args);
  return ms === 30000 ? timer.unref() : timer;
};
try { dialog.close('close'); await exportFlow; }
finally { globalThis.setTimeout = schedule; }
clearTimeout((await import('../ui.js')).toast._t);
console.log('Studio home: folder long press and menu, rename without navigation, ordered publishing, progress, skip and failed-only retry');
