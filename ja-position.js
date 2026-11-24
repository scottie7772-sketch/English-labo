// Japanese subtitle position adjustment: pure functions shared by Video Lab and Studio.
// Only translation text moves. English, audio, timestamps and cue / block identifiers are never part of this model.

// Join two Japanese fragments. Latin words meeting at the seam keep a space.
export const joinJa = (a, b) => !a ? b || '' : !b ? a : /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? a + ' ' + b : a + b;

// 1.19.29 (stage 1) API, kept for compatibility: move a selection (or the whole text) to a neighbour, or swap.
export function adjustJaRows(values, i, j, swap = false, start = 0, end = 0) {
  if (i < 0 || j < 0 || i >= values.length || j >= values.length || Math.abs(i - j) !== 1) return null;
  const next = values.slice();
  if (swap) { [next[i], next[j]] = [next[j], next[i]]; return next; }
  const text = values[i] || '';
  if (!text.trim()) return null;
  start = Math.max(0, Math.min(text.length, start | 0)); end = Math.max(start, Math.min(text.length, end | 0));
  if (start === end) { start = 0; end = text.length; }
  const part = text.slice(start, end);
  if (!part.trim()) return null;
  // The part keeps reading order: moving down it goes in front of the next text, moving up it goes after the previous.
  next[i] = (text.slice(0, start) + text.slice(end)).trim();
  next[j] = j < i ? joinJa(values[j] || '', part.trim()) : joinJa(part.trim(), values[j] || '');
  return next;
}

// ---------- editor model ----------
// rows:   [{ id, en, own, groups: [key] }]   own = the row's individual translation, groups = shared translations it shows
// groups: Map key -> { text, members: [id] } (a translation shared by several subtitles)
export function jaModel(rows, groups = new Map()) {
  const index = new Map(rows.map((row, i) => [row.id, i]));
  const shared = new Map();
  for (const [key, group] of groups) {
    const members = group.members.filter(id => index.has(id));
    // A shared translation that also belongs to a subtitle outside this list cannot be reassigned safely here.
    shared.set(key, { key, text: group.text, members: members.map(id => index.get(id)).sort((a, b) => a - b),
      complete: members.length === group.members.length, memberIds: group.members.slice() });
  }
  return {
    ids: rows.map(row => row.id), en: rows.map(row => row.en || ''),
    rowGroups: rows.map(row => (row.groups || []).filter(key => shared.has(key))),
    groups: shared, index,
    initial: { own: rows.map(row => row.own || ''), dissolved: new Map() },
  };
}
const fail = error => ({ error });
const withOwn = (state, own) => ({ own, dissolved: state.dissolved });
export const isLocked = (model, state, i) => model.rowGroups[i]?.some(key => !state.dissolved.has(key)) || false;
const lockError = (model, state, list) => {
  const locked = list.filter(i => isLocked(model, state, i));
  return locked.length ? `共有訳の行（${locked.map(i => '#' + (i + 1)).join('・')}）は先に共有を解除してください` : '';
};
const inRange = (model, i) => i >= 0 && i < model.ids.length;

// Move a selection [start,end) of row i (or the whole text when nothing is selected) to row i+d (d = ±1).
export function moveText(model, state, i, d, start = 0, end = 0) {
  const j = i + d;
  if (!inRange(model, i) || !inRange(model, j) || Math.abs(d) !== 1) return fail('移動先の行がありません');
  const locked = lockError(model, state, [i, j]); if (locked) return fail(locked);
  const next = adjustJaRows(state.own, i, j, false, start, end);
  return next ? { state: withOwn(state, next) } : fail('移動する訳がありません');
}
export function swapRows(model, state, i, d) {
  const j = i + d;
  if (!inRange(model, i) || !inRange(model, j) || Math.abs(d) !== 1) return fail('交換する行がありません');
  const locked = lockError(model, state, [i, j]); if (locked) return fail(locked);
  if (state.own[i] === state.own[j]) return fail('交換しても変わりません');
  return { state: withOwn(state, adjustJaRows(state.own, i, j, true)) };
}
// Split row i at character position pos: dir 1 = the part after pos goes to the next row, -1 = the part before pos to the previous row.
export function splitRow(model, state, i, pos, dir) {
  const text = state.own[i] || '';
  if (!(pos > 0 && pos < text.length)) return fail('分割位置は訳の途中を指定してください');
  return dir > 0 ? moveText(model, state, i, 1, pos, text.length) : moveText(model, state, i, -1, 0, pos);
}
// Pull the neighbour's translation into row i (d = -1: previous, 1: next). Nothing is discarded.
export function mergeInto(model, state, i, d) {
  const j = i + d;
  if (!inRange(model, i) || !inRange(model, j) || Math.abs(d) !== 1) return fail('結合する行がありません');
  const locked = lockError(model, state, [i, j]); if (locked) return fail(locked);
  if (!state.own[j]?.trim()) return fail('結合する訳がありません');
  const own = state.own.slice();
  own[i] = d < 0 ? joinJa(own[j], own[i]) : joinJa(own[i], own[j]);
  own[j] = '';
  return { state: withOwn(state, own) };
}
export function editText(model, state, i, text) {
  if (!inRange(model, i)) return fail('行がありません');
  const locked = lockError(model, state, [i]); if (locked) return fail(locked);
  if (state.own[i] === text) return { state };
  const own = state.own.slice(); own[i] = text;
  return { state: withOwn(state, own) };
}

// Move the translations of rows a..b by d rows (any range, not only "to the end").
// Rows outside the range that receive a translation are collisions: mode 'merge' joins the texts, 'swap' moves the displaced
// translations into the rows the range left. Without a mode only the preview is returned. Nothing is ever dropped:
// translations that would leave the material (beyond the first / last row) are merged into that row ('merge' only).
export function rangeMove(model, state, a, b, d, mode = null) {
  const n = model.ids.length;
  if (a > b) [a, b] = [b, a];
  d = Math.trunc(d);
  if (!inRange(model, a) || !inRange(model, b) || !d) return fail('範囲と移動量を指定してください');
  const target = p => Math.max(0, Math.min(n - 1, p + d));
  const overflow = [];
  for (let p = a; p <= b; p++) if (p + d < 0 || p + d > n - 1) overflow.push(p);
  const inside = p => p >= a && p <= b;
  const targets = new Set(); for (let p = a; p <= b; p++) targets.add(target(p));
  const outside = [...targets].filter(p => !inside(p)).sort((x, y) => x - y);
  const vacated = []; for (let p = a; p <= b; p++) if (!targets.has(p)) vacated.push(p);
  const collisions = outside.filter(p => state.own[p]?.trim());
  const involved = [...new Set([...Array.from({ length: b - a + 1 }, (_, k) => a + k), ...targets])];
  const locked = lockError(model, state, involved); if (locked) return fail(locked);
  const moving = Array.from({ length: b - a + 1 }, (_, k) => state.own[a + k]).filter(text => text?.trim()).length;
  const preview = { a, b, d, collisions, overflow, vacated, moving, needsChoice: collisions.length > 0 || overflow.length > 0 };
  if (!moving) return { ...preview, error: '範囲内に移動する訳がありません' };
  if (preview.needsChoice && !mode) return preview;
  if (mode === 'swap' && overflow.length) return { ...preview, error: '端を超える移動は交換できません（結合を選ぶか範囲を狭めてください）' };
  const own = state.own.slice();
  for (let p = a; p <= b; p++) own[p] = '';
  const incoming = new Map();
  for (let p = a; p <= b; p++) {
    const text = state.own[p] || ''; if (!text) continue;
    const t = target(p);
    incoming.set(t, joinJa(incoming.get(t) || '', text));
  }
  const displaced = outside.map(p => state.own[p] || '');
  // swap = a rotation: every row the range moves onto gives its translation to the rows the range left
  if (mode === 'swap') for (const p of outside) own[p] = '';
  for (const [t, text] of incoming) {
    if (!inside(t) && state.own[t]?.trim()) {
      if (mode === 'swap') own[t] = text;
      else own[t] = d > 0 ? joinJa(text, state.own[t]) : joinJa(state.own[t], text);
    } else own[t] = text;
  }
  if (mode === 'swap') displaced.forEach((text, k) => { if (text && vacated[k] != null) own[vacated[k]] = joinJa(own[vacated[k]], text); });
  return { ...preview, state: withOwn(state, own) };
}

// Release a shared translation: it becomes the individual translation of its first subtitle; the other subtitles
// lose it (shown in the impact list) and can then receive parts of it with split / move.
export function sharedImpact(model, key) {
  const group = model.groups.get(key);
  if (!group) return null;
  return { key, text: group.text, members: group.members, complete: group.complete, recipient: group.members[0] };
}
export function dissolve(model, state, key) {
  const group = model.groups.get(key);
  if (!group) return fail('共有訳が見つかりません');
  if (!group.complete) return fail('この共有訳は表示範囲外の字幕にも使われています。範囲を広げてください');
  if (state.dissolved.has(key)) return fail('共有はすでに解除しています');
  const own = state.own.slice(), first = group.members[0];
  own[first] = joinJa(group.text, own[first]);
  const dissolved = new Map(state.dissolved); dissolved.set(key, model.ids[first]);
  return { state: { own, dissolved } };
}

// ---------- results ----------
const visible = text => (text || '').replace(/\s+/g, '');
export function jaChanges(model, state) {
  const out = [];
  model.ids.forEach((id, i) => {
    const before = model.initial.own[i].trim(), after = (state.own[i] || '').trim();
    const groups = model.rowGroups[i], kept = groups.filter(key => !state.dissolved.has(key));
    if (before === after && kept.length === groups.length) return;
    out.push({ id, index: i, en: model.en[i], before: { own: before, groups }, after: { own: after, groups: kept } });
  });
  return out;
}
// Characters before / after (ignoring spaces): a smaller total means text was deleted by direct editing.
export function jaBalance(model, state) {
  const sharedText = keys => keys.reduce((sum, key) => sum + visible(model.groups.get(key)?.text).length, 0);
  const groupKeys = [...model.groups.keys()];
  const before = model.initial.own.reduce((sum, text) => sum + visible(text).length, 0) + sharedText(groupKeys);
  const after = state.own.reduce((sum, text) => sum + visible(text).length, 0) + sharedText(groupKeys.filter(key => !state.dissolved.has(key)));
  return { before, after, lost: Math.max(0, before - after) };
}
// Text shown for row i in the editor (own + still shared), for previews / comparison.
export function rowText(model, state, i) {
  return [...model.rowGroups[i].filter(key => !state.dissolved.has(key)).map(key => model.groups.get(key).text), state.own[i] || '']
    .filter(Boolean).join('\n');
}
