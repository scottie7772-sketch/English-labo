import { sdb, newId } from './studio-db.js';
import { orderStudioJaSections } from './studio-ja.js';

const registry = 'studio-folders';
const corpusKey = id => 'studio-folder-ja:' + id;

// Keep the existing folder-name field on sets for older packs and studio tools.
export async function studioFolders(sets) {
  const known = (await sdb.get('meta', registry))?.folders || [];
  if (sets.every(set => !set.folder || known.some(folder => folder.name === set.folder))) return known;
  return editFolders((folders, current) => {
    for (const set of current.sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!set.folder || folders.some(folder => folder.name === set.folder)) continue;
      folders.push({ id: newId('folder_'), name: set.folder, order: current.filter(member => member.folder === set.folder).map(member => member.id) });
    }
    return folders;
  });
}

function editFolders(edit) {
  let result, failure;
  return sdb.tx(['meta', 'sets'], 'readwrite', tx => {
    const meta = tx.objectStore('meta'), sets = tx.objectStore('sets');
    const request = meta.get(registry);
    request.onsuccess = () => {
      const all = sets.getAll();
      all.onsuccess = () => {
        const folders = request.result?.folders || [];
        try {
          result = edit(folders, all.result, set => sets.put(set));
          meta.put({ key: registry, folders });
        } catch (error) { failure = error; tx.abort(); }
      };
    };
  }).then(() => result, error => { throw failure || error; });
}

export function folderMembers(sets, folder) {
  const rank = new Map(folder.order.map((id, index) => [id, index]));
  return sets.filter(set => set.folder === folder.name).sort((a, b) =>
    (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) ||
    (a.createdAt || 0) - (b.createdAt || 0) || a.title.localeCompare(b.title, 'ja', { numeric: true }));
}

export function createStudioFolder(name) {
  return editFolders((folders, sets) => {
    const existing = folders.find(folder => folder.name === name);
    if (existing) return existing;
    const folder = { id: newId('folder_'), name, order: sets.filter(set => set.folder === name).map(set => set.id) };
    folders.push(folder);
    return folder;
  });
}

export function renameStudioFolder(id, name) {
  return editFolders((folders, sets, save) => {
    const folder = folders.find(folder => folder.id === id);
    if (!folder) throw Error('フォルダが見つかりません');
    if (folders.some(other => other.id !== id && other.name === name) || sets.some(set => set.folder === name && name !== folder.name)) {
      throw Error('同じ名前のフォルダがあります');
    }
    for (const set of sets) if (set.folder === folder.name) save({ ...set, folder: name });
    folder.name = name;
  });
}

export function moveStudioSets(ids, destination) {
  return editFolders((folders, sets, save) => {
    const target = destination && folders.find(folder => folder.id === destination);
    if (destination && !target) throw Error('移動先のフォルダが見つかりません');
    const byId = new Map(sets.map(set => [set.id, set]));
    const moved = [...new Set(ids)].filter(id => byId.has(id) && byId.get(id).folder !== target?.name);
    const moving = new Set(moved);
    for (const folder of folders) folder.order = folderMembers(sets, folder).map(set => set.id).filter(id => !moving.has(id));
    if (target) target.order.push(...moved);
    for (const id of moved) {
      const set = byId.get(id);
      if (target) set.folder = target.name;
      else delete set.folder;
      save(set);
    }
  });
}

export function saveStudioFolderOrder(id, order) {
  return editFolders((folders, sets) => {
    const folder = folders.find(folder => folder.id === id);
    if (!folder) throw Error('フォルダが見つかりません');
    const members = folderMembers(sets, folder).map(set => set.id);
    if (order.length !== members.length || new Set(order).size !== members.length || order.some(id => !members.includes(id))) {
      throw Error('フォルダの教材が変更されました。順序を開き直してください');
    }
    folder.order = order;
  });
}

export const getFolderJa = id => sdb.get('meta', corpusKey(id));

export function mergeFolderJaSections(previous, incoming) {
  const sourceKey = section => JSON.stringify([section.data?.materialId ?? null, section.name.split('/').at(-1).normalize('NFC').toLowerCase()]);
  const byName = new Map(previous.map(section => [sourceKey(section), section]));
  for (const section of incoming) byName.set(sourceKey(section), section);
  const seen = new Set();
  return orderStudioJaSections([...byName.values()].filter(section => {
    const key = JSON.stringify(section.data);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export async function saveFolderJa(id, incoming, append) {
  let count;
  await sdb.tx(['meta'], 'readwrite', tx => {
    const store = tx.objectStore('meta'), key = corpusKey(id);
    const request = store.get(key);
    request.onsuccess = () => {
      const previous = append ? request.result?.sections || [] : [];
      const sections = mergeFolderJaSections(previous, incoming);
      count = sections.length;
      store.put({ key, sections, updatedAt: Date.now() });
    };
  });
  return count;
}
