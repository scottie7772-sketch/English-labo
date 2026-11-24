import assert from 'node:assert/strict';
globalThis.window = globalThis; globalThis.localStorage = { getItem() { return null; }, setItem() {} };
const { planApply, newOrder, tagsFor, cuesOf, isScriptRow } = await import('../studio-kinfure.js');
const { parseKinfureScript } = await import('../studio-kinfure-range.js');
const rows = []; for (let n = 1; n <= 10; n++) { rows.push({ text: `${n}. head${n}x` }); rows.push({ text: `This is the example sentence number ${n} for the head.` }); }
const script = parseKinfureScript(rows); script.savedAt = 111;
const mk = (i, extra = {}) => ({ id: 'b' + i, text: script.lines[i].text, script: true, segments: [], lineage: { op: 'create' }, ...extra });
const blocks = script.lines.map((_, i) => mk(i));
// 手を付けた行: 音声割当済み(行6)・手動(行7)・作成後に編集された(行8: lineage.op≠create)・範囲外
blocks[6] = mk(6, { segments: [{ sourceId: 's', start: 1, end: 2 }], aligned: true });
blocks[7] = mk(7, { sync: 'manual' });
blocks[8] = mk(8, { lineage: { op: 'duplicate' } });
const asr = { id: 'asr1', text: 'something heard', asr: true, segments: [{ sourceId: 's', start: 30, end: 31 }] };
const all = [...blocks, asr];
const range = { startLine: 10, endLine: 15 };   // 範囲 = 行10〜15（グループ6・7・8）
const plan = planApply(all, script, range);
assert.deepEqual(plan.remove.map((b) => b.id).sort(), [...Array(20).keys()].filter((i) => i < 10 || i > 15).filter((i) => ![6, 7, 8].includes(i)).map((i) => 'b' + i).sort(), '手を付けていない範囲外の行だけを外す');
assert.deepEqual(plan.keptOutside.map((b) => b.id).sort(), ['b6', 'b7', 'b8'], '音声割当済み・手動・編集済みは残す');
assert.equal(plan.add.length, 0, '範囲内の行はすでにあるので追加なし');
assert(!plan.remove.some((b) => b.asr), 'ASR行は触らない');
// 範囲を広げる: 既存行(範囲外で外された後)に対して追加行が全体スクリプトの位置に差し込まれる
const kept = all.filter((b) => !plan.remove.includes(b)), order = kept.map((b) => b.id);
const plan2 = planApply(kept, script, { startLine: 8, endLine: 17 });
assert.deepEqual(plan2.add, [9, 16, 17].filter((i) => !plan2.present.has(i)), '足りない行だけ');
const addRows = plan2.add.map((i) => ({ id: 'n' + i, kf: { i } }));
const o2 = newOrder(order, null, plan2.tags, new Set(), addRows);
const pos = (id) => o2.indexOf(id);
assert(pos('n9') > pos('b8') && pos('n9') < pos('b10'), '行9は行8と行10の間');
assert(pos('n16') > pos('b15') && pos('n17') > pos('n16'), '行16・17は行15の後ろ、順序どおり');
assert(o2.includes('asr1') && o2.length === order.length + addRows.length, 'ASR行・既存行は消えない');
// 全体スクリプトを差し替えたら、古い kf タグは信用せず文の一致で対応づけ直す
const tagged = [{ ...mk(3), kf: { i: 99, at: 1 } }];
assert.equal(tagsFor(tagged, script).get('b3'), 3, '別の全体スクリプトのタグは無視');
assert.equal(tagsFor([{ ...mk(3), kf: { i: 5, at: 111 } }], script).get('b3'), 5, '同じ全体スクリプトのタグは使う');
// 範囲特定に使う文字起こし: ASRと照合済み行だけ。未割当のスクリプト行は含めない
const cues = cuesOf(all);
assert.deepEqual(cues.map((c) => c.text).sort(), ['something heard', script.lines[6].text].sort());
assert(isScriptRow(blocks[0]) && !isScriptRow(asr));
console.log('kinfure apply passed: 範囲外は手を付けていない行だけ外す・割当/手動/編集済み保護・範囲拡大時の差し込み順・差し替え後のタグ・ASR再利用');
