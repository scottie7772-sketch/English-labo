import assert from 'node:assert/strict';
const core = await import('../vocab-audio-core.js');
const { detectProfile, extractItems, gradeItems, recheckItems, summarize, isRegistrable, deriveState, phoneticKey, phoneticSim, matchCue, snapRange, findPhrase, phraseRange } = core;

const seg = (start, end, key = 'vk') => ({ store: 'vblobs', key, sourceKey: 'vblobs:' + key, size: 1000, start, end });
const R = (id, text, extra = {}) => ({ id, text, ja: '', segments: [], confirmed: false, ...extra });
const CTX = { from: 'lab', materialId: 'm1', title: 'T' };

// ---------- 教材タイプの自動判定 ----------
const kinfure = [];
for (let n = 1; n <= 12; n++) kinfure.push(R('h' + n, ['allocate', 'compromise', 'estimate', 'dispute', 'refund', 'invoice'][n % 6] + n, { role: 'word', group: 'g' + n }), R('e' + n, 'We need to handle this matter carefully today.', { role: 'example', group: 'g' + n, segments: [seg(n, n + 1), seg(n + 2, n + 3)], rep: 2 }));
assert.equal(detectProfile(kinfure, { materialType: 'vocab' }).profile, 'kinfure');
// 役割が付いていない（Studioの素の行）でも、見出し語→例文の並びと復唱で判定できる
const bare = kinfure.map(({ role, group, ...r }) => r);
assert.equal(detectProfile(bare).profile, 'kinfure');
const wordlist = ['allocate', 'compromise', 'estimate', 'dispute', 'refund', 'invoice', 'on behalf of', 'in charge of', 'take over', 'figure out'].map((t, i) => R('w' + i, `${i + 1}. ${t}`));
const wl = detectProfile(wordlist);
assert.equal(wl.profile, 'wordlist');
assert(wl.reasons.some(x => /短い単語/.test(x)));
const dialogue = ['A: Hi, how was your weekend?', 'B: It was great, thanks. I went hiking.', 'A: Really? Where did you go?', 'B: To the mountains near my town.', 'A: That sounds wonderful.', 'B: You should come next time.'].map((t, i) => R('d' + i, t));
assert.equal(detectProfile(dialogue).profile, 'dialogue');
const prose = ['CHAPTER ONE', 'The old house stood at the end of the lane, its windows dark and its garden long since given over to weeds and brambles.', 'Nobody in the village could remember who had last lived there, though everyone agreed that the lights had once been kept burning all night.'].map((t, i) => R('p' + i, t));
assert.equal(detectProfile(prose).profile, 'prose');
assert.equal(detectProfile([]).profile, 'prose');   // 何もなければ安全側
assert.equal(detectProfile(dialogue, { materialType: 'prose' }).profile, 'dialogue', '保存された種類より、中身の構造を優先する');

// ---------- 見出し語・例文・文全体の抽出（独立した参照） ----------
const rows = [
  R('w1', 'allocate', { role: 'word', group: 'a', ja: '割り当てる', confirmed: true, segments: [seg(1, 1.6)] }),
  R('x1', 'We allocate funds to each team.', { role: 'example', group: 'a', ja: '各チームに資金を割り当てる。', segments: [seg(2, 4), seg(4.6, 6.6)], confirmed: true }),
  R('w2', 'compromise', { role: 'word', group: 'b', ja: '妥協する', confirmed: true, segments: [seg(7, 7.7)] }),
  R('x2', 'They reached a compromise.', { role: 'example', group: 'b', segments: [], confirmed: false }),        // 例文の音声照合に失敗
  R('w3', 'estimate', { role: 'word', group: 'c', segments: [seg(12, 12.6)], estimated: true }),                  // 推定時刻
];
let { items } = extractItems(rows, 'kinfure', CTX);
assert.equal(items.length, 3);
assert.deepEqual(items.map(i => [i.head, i.example, Boolean(i.refs.word), Boolean(i.refs.example)]), [['allocate', 'We allocate funds to each team.', true, true], ['compromise', 'They reached a compromise.', true, false], ['estimate', '', true, false]]);
assert(items[1].issues.some(x => /例文の音声が未割当/.test(x)));
assert.equal(items[0].refs.example.repeats, 2);
assert.equal(items[0].refs.word.ref.limit.max, 2, '見出し語は例文の音声に入らない');
gradeItems(items, rows);
assert.deepEqual(items.slice(0, 2).map(i => i.refs.word.tier), ['high', 'high']);
assert.notEqual(items[2].refs.word.tier, 'high', '推定時刻は確定にならない');
assert.equal(items[2].refs.word.ref.state, 'unconfirmed');
// 見出し語優先: 例文が失敗しても、見出し語が確定していれば登録できる
assert(isRegistrable(items[1], 'head'));
assert(!isRegistrable(items[2], 'head'));
const sm = summarize(items, 'head');
assert.deepEqual([sm.total, sm.wordConfirmed, sm.exampleConfirmed, sm.registrable], [3, 2, 1, 2]);
const sm2 = summarize(items, 'example');
assert.equal(sm2.complete, 1, '「見出し語＋例文」では、例文まで確定したものだけを完了とする');
assert.equal(sm.complete, 2);

// 文章・発話全体
({ items } = extractItems(dialogue.map((r, i) => ({ ...r, confirmed: true, segments: [seg(i * 3, i * 3 + 2.5)] })), 'dialogue', { ...CTX, mode: 'sentence' }));
assert.equal(items.length, 6);
assert(items.every(i => i.refs.sentence && !i.refs.word));

// 一般単語型: 次の見出し語までの間にある、その語を含む文を例文にする
const wl2 = [R('a', '1. allocate', { confirmed: true, segments: [seg(1, 1.5)] }), R('b', 'We allocate funds.', { confirmed: true, segments: [seg(2, 3)] }), R('c', '2. refund', { confirmed: true, segments: [seg(4, 4.5)] }), R('d', '3. invoice', { confirmed: true, segments: [seg(6, 6.5)] })];
({ items } = extractItems(wl2, 'wordlist', CTX));
assert.deepEqual(items.map(i => [i.head, i.example]), [['allocate', 'We allocate funds.'], ['refund', ''], ['invoice', '']]);

// 会話・朗読: 単語リストの語が入った発話。語ごとの時刻があるときだけ、語の範囲を参照にする
const talk = [R('u1', 'A: I need to figure out the budget.', { confirmed: true, segments: [seg(0, 3)], wordTimings: [{ text: 'A:', start: 0, end: .2 }, { text: 'I', start: .3, end: .4 }, { text: 'need', start: .4, end: .7 }, { text: 'to', start: .7, end: .8 }, { text: 'figure', start: .9, end: 1.3 }, { text: 'out', start: 1.3, end: 1.6 }, { text: 'the', start: 1.7, end: 1.8 }, { text: 'budget.', start: 1.9, end: 2.5 }] }),
  R('u2', 'B: We should take over the project.', { confirmed: true, segments: [seg(4, 7)] })];
({ items } = extractItems(talk, 'dialogue', { ...CTX, wordList: ['figure out', 'take over', 'hand in'] }));
assert.equal(items.length, 3);
assert.deepEqual([items[0].refs.word.ref.start, items[0].refs.word.ref.end], [.9, 1.6]);
assert.equal(items[0].refs.sentence.ref.start, 0);
assert.equal(items[1].refs.word, null, '語ごとの時刻がなければ、文全体を見出し語の音声にしない');
assert.equal(items[1].candidates[0].est, true);
assert(items[1].refs.sentence);
assert.equal(items[2].refs.sentence, null);
assert(items[2].issues.some(x => /見つかりません/.test(x)));
gradeItems(items, talk);
assert.equal(items[0].refs.word.tier, 'high');
assert.equal(items[1].state, 'candidates');
assert.equal(items[2].state, 'unresolved');
assert.equal(extractItems(talk, 'dialogue', CTX).notes.length, 1, '単語リストがなければ案内する');
assert.equal(findPhrase('We took over the project', 'take over'), -1);   // 語尾変化: took は別の語（誤一致しない）
assert.equal(findPhrase('She takes over the project', 'take over'), 1);
assert.equal(phraseRange({ wordTimings: [{ text: 'a', start: 0, end: 1 }] }, 'zzz'), null);

// ---------- 確信度の内訳 ----------
{
  const g = (rowsIn, profile = 'kinfure') => { const r = extractItems(rowsIn, profile, CTX).items; gradeItems(r, rowsIn); return r; };
  const base = [R('w', 'allocate', { role: 'word', group: 'a', confirmed: true, segments: [seg(1, 1.5)] })];
  assert.equal(g(base)[0].refs.word.tier, 'high');
  // 手で確定した行は最も高い
  assert(g([{ ...base[0], manual: true }])[0].refs.word.score > g(base)[0].refs.word.score);
  // 長さが不自然（見出し語が8秒）→ 確定にしない
  assert.notEqual(g([{ ...base[0], segments: [seg(1, 9)] }])[0].refs.word.tier, 'high');
  // 他の行の音声と重なる → 確定にしない
  const over = [R('w', 'allocate', { role: 'word', group: 'a', confirmed: true, segments: [seg(1, 1.5)] }), R('e', 'We allocate funds.', { role: 'example', group: 'a', confirmed: true, segments: [seg(1.2, 3)] })];
  const o = g(over)[0].refs.word;
  assert.notEqual(o.tier, 'high'); assert(o.reasons.some(x => /重なる/.test(x)));
  // 並びが逆（前の項目より前にある）→ 確定にしない
  const rev = [R('w1', 'allocate', { role: 'word', group: 'a', confirmed: true, segments: [seg(10, 10.5)] }), R('w2', 'refund', { role: 'word', group: 'b', confirmed: true, segments: [seg(3, 3.5)] })];
  const ri = g(rev);
  assert.equal(ri[0].refs.word.tier, 'high'); assert.notEqual(ri[1].refs.word.tier, 'high');
  assert(ri[1].refs.word.reasons.some(x => /並びが逆/.test(x)));
  // 発話の境界: 語頭が欠けている・別の発話が混ざる
  const regions = new Map([['vblobs:vk', [[0.8, 1.4], [1.7, 2.2]]]]);
  const clip = extractItems([R('w', 'allocate', { role: 'word', group: 'a', confirmed: true, segments: [seg(1.2, 1.4)] })], 'kinfure', CTX).items;
  gradeItems(clip, [R('w', 'allocate', { confirmed: true, segments: [seg(1.2, 1.4)] })], { regions });
  assert(clip[0].refs.word.reasons.some(x => /語頭が欠けている/.test(x)));
  const mixed = extractItems([R('w', 'allocate', { role: 'word', group: 'a', confirmed: true, segments: [seg(1.0, 2.1)] })], 'kinfure', CTX).items;
  gradeItems(mixed, [R('w', 'allocate', { confirmed: true, segments: [seg(1.0, 2.1)] })], { regions });
  assert(mixed[0].refs.word.reasons.some(x => /別の発話が混ざる/.test(x)));
  // 復唱の長さが揃わない例文
  const rep = [R('w', 'allocate', { role: 'word', group: 'a', confirmed: true, segments: [seg(1, 1.5)] }), R('e', 'We allocate funds.', { role: 'example', group: 'a', confirmed: true, segments: [seg(2, 4), seg(5, 9)] })];
  assert.notEqual(g(rep)[0].refs.example.tier, 'high');
}

// ---------- 音韻の類似・文字起こしとの一致 ----------
assert.equal(phoneticKey('allocate'), phoneticKey('a locate'));
assert(phoneticSim('compromise', 'comprimise') >= .8);
assert(phoneticSim('allocate', 'refund') < .4);
assert.equal(matchCue('allocate', { text: 'Allocate.', start: 1, end: 1.6 }).score, 1);
assert(matchCue('allocate', { text: 'a locate', start: 1, end: 1.6 }).score >= .7);
assert(matchCue('allocate', { text: 'we need to refund the customer', start: 1, end: 3 }).score < .4);
const inside = matchCue('figure out', { text: 'I need to figure out the budget', start: 0, end: 3, wordTimings: talk[0].wordTimings.map(w => ({ ...w })) });
assert.equal(inside.score, .95); assert.deepEqual(inside.range, { start: .9, end: 1.6 });
assert.equal(matchCue('figure out', { text: 'I need to figure out the budget', start: 0, end: 3 }).est, true, '位置が推定のものは推定として返す');

// ---------- 発話の境界に合わせる ----------
let sn = snapRange({ start: 1.2, end: 1.4 }, [[1.0, 1.6]], { limit: { min: 0.9, max: 2 } });
assert.deepEqual([sn.snapped, sn.start, sn.end, sn.extendedHead, sn.extendedTail], [true, .94, 1.74, true, true], '欠けた語頭・語尾を広げる');
sn = snapRange({ start: 1.0, end: 2.1 }, [[1.0, 1.4], [1.7, 2.2]], { kind: 'word' });
assert.equal(sn.trimmed, true); assert(sn.end < 1.7, '見出し語に混ざった別の発話は落とす');
sn = snapRange({ start: 1.0, end: 2.1 }, [[1.0, 1.4], [1.7, 2.2]], { kind: 'example' });
assert.equal(sn.end, 2.34, '文は途中の短い間を含めて1つにする');
sn = snapRange({ start: 1.2, end: 1.4 }, [[1.0, 1.6]], { limit: { min: 1.1, max: 1.5 } });
assert.deepEqual([sn.start, sn.end], [1.1, 1.5], '前後の行の音声には入らない');
assert.equal(snapRange({ start: 5, end: 6 }, [[1, 2]]).snapped, false);

// ---------- 局所的な再照合 ----------
const mk = (heads, anchors = {}) => {
  const r = heads.map((h, i) => R('w' + i, h, { role: 'word', group: 'g' + i, confirmed: Boolean(anchors[i]), segments: anchors[i] ? [seg(...anchors[i])] : [] }));
  const it = extractItems(r, 'kinfure', CTX).items; gradeItems(it, r); return { rows: r, items: it };
};
const ev = (id, text, start, end) => ({ id, text, start, end, sourceKey: 'vblobs:vk', store: 'vblobs', key: 'vk', size: 1000 });
{
  // 錨(確定済み)の間にある、聞き間違えられた見出し語を特定する
  const { items: it } = mk(['allocate', 'compromise', 'estimate'], { 0: [1, 1.6], 2: [7, 7.6] });
  const out = recheckItems(it, { evidence: [ev('c1', 'a locate', 1, 1.6), ev('c2', 'comprimise', 4, 4.8), ev('c3', 'estimate', 7, 7.6), ev('c9', 'refund', 5.5, 6)], origin: CTX });
  assert.equal(it[1].state, 'confirmed');
  assert.equal(it[1].refs.word.ref.start, 4); assert.equal(it[1].refs.word.ref.state, 'confirmed');
  assert(it[1].refs.word.fromRecheck);
  assert.deepEqual(out.find(x => x.key === it[1].key).outcome, 'found');
  assert.deepEqual(it[1].recheck.windowed, [1.55, 7.05], '調べたのは前後の錨の間だけ');
}
{
  // 窓の中に似た候補が2つ: 自動で確定せず、候補として残す
  const { items: it } = mk(['allocate', 'dispute', 'estimate'], { 0: [1, 1.6], 2: [9, 9.6] });
  recheckItems(it, { evidence: [ev('a', 'dispute', 3, 3.5), ev('b', 'dispute', 6, 6.5)], origin: CTX });
  assert.equal(it[1].state, 'candidates'); assert.equal(it[1].candidates.length, 2);
  assert.notEqual(it[1].refs.word?.ref.state, 'confirmed');
}
{
  // 錨の外の同じ語は使わない（順序の制約）
  const { items: it } = mk(['allocate', 'dispute', 'estimate'], { 0: [1, 1.6], 2: [9, 9.6] });
  recheckItems(it, { evidence: [ev('far', 'dispute', 30, 30.5), ev('before', 'dispute', .1, .6)], origin: CTX });
  assert.equal(it[1].state, 'unresolved');
}
{
  // 既存の推定時刻を、文字起こしが裏付けたら確定にする。別の場所を示すなら候補にとどめる
  const base = (start) => { const r = [R('w0', 'allocate', { role: 'word', group: 'a', segments: [seg(start, start + .6)], estimated: true })]; const it = extractItems(r, 'kinfure', CTX).items; gradeItems(it, r); return it; };
  let it = base(3); assert.notEqual(it[0].refs.word.tier, 'high');
  recheckItems(it, { evidence: [ev('a', 'allocate', 3.02, 3.62)], origin: CTX });
  assert.equal(it[0].state, 'confirmed'); assert(it[0].recheck.promoted); assert(it[0].refs.word.reasons.includes('文字起こしで裏付け'));
  it = base(3);
  recheckItems(it, { evidence: [ev('a', 'allocate', 10, 10.6)], origin: CTX });
  assert.equal(it[0].state, 'candidates'); assert.equal(it[0].refs.word.ref.state, 'unconfirmed');
  assert.equal(it[0].candidates[0].start, 10);
  // 裏付けがなければ推定のまま
  it = base(3); recheckItems(it, { evidence: [], origin: CTX });
  assert.equal(it[0].refs.word.ref.state, 'unconfirmed');
  // 発話の境界があれば、裏付けと同時に欠けた語頭・語尾を直す
  it = base(3);
  recheckItems(it, { evidence: [ev('a', 'allocate', 3.1, 3.5)], regions: new Map([['vblobs:vk', [[2.95, 3.65]]]]), origin: CTX });
  assert(it[0].refs.word.ref.snapped); assert(it[0].refs.word.ref.start <= 3.0);
}
{
  // 確定済みの項目は触らない
  const { items: it } = mk(['allocate'], { 0: [1, 1.6] });
  const before = JSON.stringify(it[0].refs.word);
  recheckItems(it, { evidence: [ev('x', 'something else', 1, 1.6)], origin: CTX });
  assert.equal(JSON.stringify(it[0].refs.word), before);
}

// ---------- 状態 ----------
assert.equal(deriveState({ refs: { word: null, example: null, sentence: null } }), 'unresolved');
assert.equal(deriveState({ refs: { word: { tier: 'high', ref: {}, }, example: null, sentence: null } }), 'confirmed');
assert.equal(deriveState({ refs: { word: { tier: 'mid', ref: {} } } }), 'candidates');
assert.equal(deriveState({ refs: { word: { tier: 'high', ref: {}, broken: true } } }), 'broken');
assert.equal(deriveState({ registeredId: 'x', refs: { word: { tier: 'high', ref: {} } } }), 'registered');
console.log('vocab-audio-core: profile detection, per-profile extraction, independent refs, head-first rules, confidence tiers, phonetic/ASR matching, boundary snapping, local re-check, states pass');
