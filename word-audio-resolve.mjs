import assert from 'node:assert/strict';
import './fake-idb.mjs';
const played = [];
class FakeAudio {
  constructor() { this.currentTime = 0; this.paused = true; this.ended = false; this.playbackRate = 1; this.dataset = {}; }
  set src(v) { this._src = v; if (v) setTimeout(() => this.onloadedmetadata?.(), 1); }
  get src() { return this._src; }
  play() { this.paused = false; played.push({ src: this._src, at: +this.currentTime.toFixed(3) }); clearInterval(this.timer); this.timer = setInterval(() => { if (!this.paused) this.currentTime += 0.01; }, 10); return Promise.resolve(); }
  pause() { this.paused = true; clearInterval(this.timer); }
}
globalThis.Audio = FakeAudio;
globalThis.requestAnimationFrame = fn => setTimeout(fn, 8);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
globalThis.window = globalThis; globalThis.speechSynthesis = { cancel() {} };
const { db } = await import('../db.js');
const { resolveAudio, playResolved } = await import('../word-audio-resolve.js');
const { fc2Voice } = await import('../swipecard.js');
const { makeRef } = await import('../audio-ref-model.js');
const { newWord, newSense } = await import('../words.js');

await db.put('vblobs', { id: 'vk', blob: new Blob([new Uint8Array(100)]) });
const ref = (text, a, b, state = 'confirmed') => makeRef({ store: 'vblobs', key: 'vk', size: 100, start: a, end: b, limit: { min: 0, max: null }, origin: { from: 'lab', materialId: 'm', text }, state });
const word = (head, examples, audio) => ({ ...newWord({ headword: head, senses: [newSense({ meanings: ['x'], examples: examples.map(en => ({ en, ja: '' })) })] }), audio });

// ---- 解決の規則（同期・DBに触れない） ----
const w1 = word('allocate', ['We allocate funds.'], { word: ref('allocate', 1, 1.5), example: ref('We allocate funds.', 2, 4) });
assert.deepEqual([resolveAudio(w1).via, resolveAudio(w1).ref.start], ['ref', 1]);
assert.equal(resolveAudio(w1, 'allocate').kind, 'word');
assert.deepEqual([resolveAudio(w1, 'We allocate funds.').via, resolveAudio(w1, 'We allocate funds.').ref.start], ['ref', 2]);
assert.equal(resolveAudio(w1, 'Some other sentence.').status, 'stale', '例文が書き換えられたら、元の音声は使わない（理由つきで合成音声）');
// 見出し語・例文・文全体は独立: 例文がなくても見出し語は鳴る
const w2 = word('compromise', ['They reached a compromise.'], { word: ref('compromise', 8, 8.7) });
assert.equal(resolveAudio(w2).via, 'ref'); assert.equal(resolveAudio(w2, 'They reached a compromise.').status, 'none');
// 未確定は使わない
const w3 = word('estimate', [], { word: ref('estimate', 13, 13.6, 'unconfirmed') });
assert.deepEqual([resolveAudio(w3).via, resolveAudio(w3).status], [null, 'unsure']);
assert.equal(resolveAudio(word('x', [], undefined)).status, 'none');
// 文章・発話全体: 見出し語が文そのもの / 会話・朗読: 例文の音声が文の音声
const w4 = word('How was your weekend?', [], { sentence: ref('How was your weekend?', 20, 22.5) });
assert.deepEqual([resolveAudio(w4).via, resolveAudio(w4).ref.start], ['sentence', 20]);
const w5 = word('figure out', ['I need to figure out the budget.'], { sentence: ref('I need to figure out the budget.', 30, 33) });
assert.equal(resolveAudio(w5).via, null, '文全体の音声を、見出し語の音声にはしない');
assert.deepEqual([resolveAudio(w5, 'I need to figure out the budget.').via, resolveAudio(w5, 'I need to figure out the budget.').ref.start], ['sentence', 30]);

// ---- カードの音声: 登録済みの参照から直接鳴らす（探索なし）。なければ合成音声 ----
const spoken = [];
const root = { addEventListener() {} };
const voice = fc2Voice(root, (t) => { spoken.push(t); return null; });
played.length = 0;
await voice.auto('allocate', w1, { listening: true });
assert.equal(played.length, 1); assert.equal(played[0].at, 0.94);
assert.deepEqual(spoken, [], '登録済みの音声があれば、合成音声は使わない');
await voice.tap('estimate', w3);
assert.deepEqual(spoken, ['estimate'], '未確定なら合成音声（理由は画面に出る）');
// 素早く切り替えても、最後の1つだけが鳴る
played.length = 0; spoken.length = 0;
const a = voice.tap('allocate', w1), b = voice.tap('compromise', w2);
await Promise.all([a, b]);
assert.equal(played.length, 1); assert.equal(played[0].at, 7.94);
// 見出し語→例文を続けて
played.length = 0;
await voice.both(w1);
assert.deepEqual(played.map(p => p.at), [0.94, 1.94]);
voice.stop();
console.log('word-audio-resolve: word/example/sentence resolution, unconfirmed and stale handling, direct playback from the stored reference, fast switching pass');
