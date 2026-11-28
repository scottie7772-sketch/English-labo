// 照合済みのスクリプト行と同じ内容の文字起こし（未確定の文字起こし）を見つける。純関数。
// 「見出し語・例文×2」として照合したあとに、同じ文章が音声未確定の文字起こしとして残る（見出し語＋例文がまとまった1行など）のを整理するため。
// 消すのは、手を付けていない文字起こしの行だけ（日本語訳つき・穴埋めつき・手動の行・照合済みの行は消さない）。
import { words } from './studio-align.js';

const toks = (text) => words(text).map((w) => w.w.toLowerCase().replace(/[^a-z0-9']/g, '')).filter(Boolean);
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

// blocks: set.order の順に並んだ行。assigned: この操作で割り当てた範囲（保存前でもよい）[{sourceId,start,end}]
// 戻り値: [{ block, why }]
export function duplicateTranscripts(blocks, { assigned = [], near = 12, minTokens = 3, textShare = .75, timeShare = .5 } = {}) {
  const script = (b) => !b.asr && b.text?.trim() && b.segments?.length && (b.aligned || b.sync === 'manual');
  const out = [];
  blocks.forEach((b, i) => {
    if (!b.asr || b.aligned || b.sync === 'manual' || b.ja || b.holes?.length || b.deleted || !b.text?.trim()) return;
    // (1) 時刻: この行の音声区間が、照合済みの行（と今回割り当てた範囲）の発話でほぼ覆われている
    const segs = b.segments || [];
    if (segs.length === 1) {
      const g = segs[0], dur = g.end - g.start;
      const spans = [...assigned, ...blocks.filter(script).flatMap((x) => x.segments)].filter((a) => a.sourceId === g.sourceId);
      const covered = spans.reduce((s, a) => s + overlap(a, g), 0);
      if (dur > 0 && covered >= timeShare * dur) { out.push({ block: b, why: '照合済みの行の音声と重なる' }); return; }
    }
    // (2) 文字: 前後の照合済みの行の語に、この行の語がほとんど含まれる（時刻が無い・推定のときも）
    const mine = toks(b.text);
    if (mine.length < minTokens) return;
    const nearby = [];
    for (let k = i - 1, n = 0; k >= 0 && n < near; k--) if (script(blocks[k])) { nearby.push(blocks[k]); n++; }
    for (let k = i + 1, n = 0; k < blocks.length && n < near; k++) if (script(blocks[k])) { nearby.push(blocks[k]); n++; }
    const pool = new Set(nearby.flatMap((x) => toks(x.text)));
    const hit = mine.filter((t) => pool.has(t)).length;
    if (hit / mine.length >= textShare) out.push({ block: b, why: '前後の照合済みの行と同じ内容' });
  });
  return out;
}
