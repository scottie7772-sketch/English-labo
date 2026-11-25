// 単語の音声を「どこから鳴らすか」を決める唯一の入口（金フレ・一般単語・会話・朗読・MAフレーズで共通）。
// 単語に保存済みの参照（word.audio）、またはMAフレーズの確定済みのリンクだけを見る。DBにも他の教材にも触れない（同期処理）。
// 保存済みの参照がない単語だけが、従来の「文面から元の録音を探す」処理（word-audio.js）に回る。
import { resolveRef, sameText } from './audio-ref-model.js';
import { maLinks } from './ma-phrases.js';

// text: カードに出ている文字列（見出し語、または例文）。省略すると見出し語。
// 戻り値: { via: 'ref' | 'sentence' | 'ma' | null, kind, ref?, link?, w, status?, reason? }
//   status（via が null のとき）: 'none' 音声参照なし / 'unsure' 音声区間が未確定 / 'stale' 例文が書き換えられた
export function resolveAudio(w, text = null) {
  const kind = !text || sameText(text, w?.headword) ? 'word' : 'example';
  if (!w) return { via: null, kind, status: 'none', w };
  if (w.ma) {
    if (kind === 'example') {
      const link = maLinks(w).find(l => sameText(l.ref.origin.text, text));
      return link ? { via: 'ma', kind, link, w } : { via: null, kind, status: 'none', ma: true, reason: '使用例の元音声がありません', w };
    }
    const link = maLinks(w).find(l => l.manual?.state === 'confirmed' || l.phrase);
    return link ? { via: 'ma', kind, link, w } : { via: null, kind, status: 'unsure', ma: true, reason: 'フレーズ音声は未確定、または参照切れです', w };
  }
  const found = resolveRef(w, kind);
  if (found && (kind === 'word' || sameText(found.ref.origin?.text, text))) return { via: found.via === 'sentence' ? 'sentence' : 'ref', kind, ref: found.ref, w };
  const raw = w.audio?.[kind] || w.audio?.sentence;
  // 確定済みなのに使えない = 例文が書き換えられて、音声の元の文と合わなくなった。録音が見つからない場合は再生時に分かる（playResolved が false を返す）
  return { via: null, kind, status: raw ? (raw.state === 'confirmed' ? 'stale' : 'unsure') : 'none', w };
}
// 再生。MAは参照の有効性（字幕・録音が変わっていないか）を確かめてから。それ以外は保存済みの区間をそのまま。
export async function playResolved(res, { onEnd = null, active = () => true } = {}) {
  if (!res?.via) { onEnd?.(); return false; }
  if (res.via === 'ma') return (await import('./ma-phrases.js')).playMA(res.w, res.kind, { link: res.link, onEnd, active });
  if (!active()) { onEnd?.(); return false; }
  return (await import('./word-audio.js')).playRef(res.ref, { onEnd });
}
export const STATUS_TEXT = { none: '音声参照なし', unsure: '音声区間未確定', stale: '例文が変わったため音声を使いません', broken: '音声参照切れ' };
