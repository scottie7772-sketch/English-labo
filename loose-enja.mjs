// 英和テキストのゆるい読み取り: 番号・説明文・表・コードブロック・英日交互などが混ざっていても、書かれている英語と意味を拾う。
import assert from 'node:assert/strict';
const { parseLooseEnJa } = await import('../loose-enja.js');
const P = (t) => parseLooseEnJa(t);
const one = (t) => { const r = P(t).entries; assert.equal(r.length, 1, JSON.stringify(r)); return r[0]; };

// 1行の形
assert.deepEqual(one('accommodate – 収容する').meanings, ['収容する']);
assert.deepEqual([one('1. accommodate：収容する、泊める').headword, one('1. accommodate：収容する、泊める').meanings], ['accommodate', ['収容する', '泊める']]);
assert.equal(one('12) put off 延期する').headword, 'put off');
assert.equal(one('- **refer to** … 〜に言及する').headword, 'refer to');
assert.equal(one('No.7  allocate = 割り当てる').headword, 'allocate');
assert.equal(one('accommodate (v.) 収容する').pos, 'v.'); assert.equal(one('accommodate (v.) 収容する').headword, 'accommodate');
assert.equal(one('accommodate /əˈkɒmədeɪt/ 収容する').headword, 'accommodate');
assert.deepEqual(one('adjourn 休会する（動詞）').meanings, ['休会する（動詞）'].map(x => x.replace('（動詞）', '')).concat([]).length ? ['休会する'] : []); assert.equal(one('adjourn 休会する（動詞）').pos, '動詞');
// 1行に英和英和（見出し語の意味 + 例文 + 例文訳）
{ const e = one('accommodate 収容する  Accommodate a request. 要望に応える。'); assert.equal(e.example_en, 'Accommodate a request.'); assert.equal(e.example_ja, '要望に応える。'); }
// 表・タブ・コンマ
{ const e = one('accommodate\t収容する\t動詞\tAccommodate a request.\t要望に応える'); assert.deepEqual([e.headword, e.meanings, e.pos, e.example_en, e.example_ja], ['accommodate', ['収容する'], '動詞', 'Accommodate a request.', '要望に応える']); }
{ const r = P('| 英語 | 日本語 | 例文 |\n|---|---|---|\n| allocate | 割り当てる | We allocate funds. |\n| compromise | 妥協する | They reached a compromise. |').entries; assert.equal(r.length, 2); assert.equal(r[1].example_en, 'They reached a compromise.'); assert.deepEqual(r[0].meanings, ['割り当てる']); }
{ const r = P('allocate,割り当てる,verb,"We allocate funds, today.",資金を割り当てる').entries; assert.equal(r[0].example_en, 'We allocate funds, today.'); assert.equal(r[0].pos, 'verb'); }
// 英語の行と日本語の行が交互
{ const r = P('accommodate\n収容する\nAccommodate a request.\n要望に応える。\nadjourn\n休会する\nThe meeting was adjourned.\n会議は休会になった。').entries; assert.equal(r.length, 2); assert.deepEqual(r[0].meanings, ['収容する']); assert.equal(r[0].example_ja, '要望に応える。'); assert.equal(r[1].example_en, 'The meeting was adjourned.'); }
// 見出し語の行の次に、例文だけの行が続く（例文は直前の見出し語のもの）
{ const r = P('accommodate 収容する\nAccommodate a request. 要望に応える。\nadjourn 休会する\nThe meeting was adjourned. 会議は休会になった。').entries; assert.equal(r.length, 2); assert.equal(r[0].example_en, 'Accommodate a request.'); assert.equal(r[1].example_ja, '会議は休会になった。'); }
// 説明文・見出し・番号・コードブロックが混ざる（ChatGPT の返答）
{
  const text = `もちろんです！以下に、ご指定の単語リストを作成しました。

## TOEIC頻出語

\`\`\`
1. accommodate – 収容する
2. adjourn – 休会する
3. allocate – 割り当てる
\`\`\`

**補足**：意味は文脈によって変わることがあります。
Here is the list again:
4. compromise → 妥協する
5. dispute：論争、紛争
以上です。ご不明な点があればお知らせください。`;
  const r = P(text);
  assert.deepEqual(r.entries.map(e => e.headword), ['accommodate', 'adjourn', 'allocate', 'compromise', 'dispute']);
  assert.deepEqual(r.entries[4].meanings, ['論争', '紛争']);
  assert(r.skipped.length >= 3, '説明文を読み飛ばす: ' + r.skipped.length);
}
// 番号だけの行・区切り線・見出し行（列名）
{ const r = P('英語\t日本語\n---\n1\n2\nallocate\t割り当てる').entries; assert.deepEqual(r.map(e => e.headword), ['allocate']); }
// 見出し語だけのリスト（意味なし）も拾う。説明文は拾わない
{ const r = P('accommodate\nadjourn\nallocate\ncompromise').entries; assert.equal(r.length, 4); assert(r.every(e => !e.meanings.length)); }
assert.equal(P('Here is your list.\nPlease check it carefully.\nThanks!').entries.length, 0, '説明文だけなら何も拾わない');
assert.equal(P('以下が結果です。\nよろしくお願いします。').entries.length, 0);
// 熟語・長めの見出し語、スラッシュの別表記
{ const e = one('in charge of ～を担当して'); assert.equal(e.headword, 'in charge of'); assert.deepEqual(e.meanings, ['～を担当して']); }
{ const e = one('put off / postpone 延期する'); assert.equal(e.headword, 'put off / postpone'); }
// 実際の金フレ風（見出し語＋例文＋訳）
{ const r = P('1. refer：参照する\n   Please refer to the map. 地図を参照してください。\n2. employee：従業員\n   All company employees 会社の全従業員').entries; assert.deepEqual(r.map(e => e.headword), ['refer', 'employee']); assert.equal(r[0].example_ja, '地図を参照してください。'); assert.equal(r[1].example_en, 'All company employees'); }
console.log('loose-enja: numbering, bullets, bold, tables, TSV/CSV, two-line, one-line en-ja-en-ja, code fences, chatty intro/outro, header rows, meaning-less lists');
