// CSV 取り込み・一括テキスト取り込みが、番号・説明文・表などの混ざった英和テキストも読めること。きれいな CSV の読み取りは変えない。
import assert from 'node:assert/strict';
import './fake-idb.mjs';
const { analyzeCSV, parseWordsText } = await import('../words.js');

// きれいな CSV（列名つき）: 従来どおり。ゆるい読み取りに切り替えない
{
  const a = analyzeCSV('英語,日本語,品詞,例文,例文訳\naccommodate,収容する,動詞,Accommodate a request.,要望に応える\nadjourn,休会する,動詞,The meeting was adjourned.,会議は休会になった');
  assert.equal(a.how, undefined); assert.equal(a.header, true);
  assert.deepEqual(a.entries.map(e => e.headword), ['accommodate', 'adjourn']); assert.equal(a.entries[0].example_ja, '要望に応える');
}
// 列名なしの CSV
{ const a = analyzeCSV('allocate,割り当てる\ncompromise,妥協する'); assert.deepEqual(a.entries.map(e => e.headword), ['allocate', 'compromise']); assert.equal(a.how, undefined); }
// ChatGPT の返答（説明文・番号・太字・コードブロック）
{
  const a = analyzeCSV(`はい、作成しました。

\`\`\`csv
1. accommodate, 収容する
2. adjourn, 休会する
\`\`\`

**ご確認ください**: 意味は文脈で変わります。`);
  assert.equal(a.how, 'loose'); assert.deepEqual(a.entries.map(e => e.headword), ['accommodate', 'adjourn']); assert.deepEqual(a.entries[1].meanings, ['休会する']);
  assert(a.notes.some(n => /説明文|混ざった/.test(n)));
}
// 表（Markdown）・番号つき・訳が別の行
assert.deepEqual(analyzeCSV('| No | 英語 | 日本語 |\n|---|---|---|\n| 1 | allocate | 割り当てる |\n| 2 | refund | 返金する |').entries.map(e => e.headword), ['allocate', 'refund']);
assert.deepEqual(analyzeCSV('1. allocate\n割り当てる\n2. refund\n返金する').entries.map(e => [e.headword, e.meanings[0]]), [['allocate', '割り当てる'], ['refund', '返金する']]);
// 手で列を指定したときは CSV としてだけ読む
{ const a = analyzeCSV('x,y\nallocate,割り当てる', { headword: 0, meanings: 1 }); assert.equal(a.how, undefined); assert.equal(a.entries.length, 2); }
// 一括テキスト（1行1語）
assert.deepEqual(parseWordsText('1. put off 延期する\n2. refer to – 〜に言及する\n以上です').map(e => [e.headword, e.meanings[0]]), [['put off', '延期する'], ['refer to', '〜に言及する']]);
assert.deepEqual(parseWordsText('postpone, 延期する\nallocate\t割り当てる').map(e => e.headword), ['postpone', 'allocate'], '従来の形は変わらない');
console.log('words-loose-import: clean CSV unchanged; chatty text, tables, two-line, numbered lines are read loosely');
