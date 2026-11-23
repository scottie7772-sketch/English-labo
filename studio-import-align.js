// Local-only, conservative alignment of independently recognised utterances.
// Speech boundaries are determined before ASR; script text is never inferred from silence.
const words = s => (String(s||'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]);
export function similarity(a,b) {
  const x=words(a),y=words(b); if(!x.length||!y.length)return 0;
  if(x.join(' ')===y.join(' '))return 1;
  const n=x.length,m=y.length,d=Array.from({length:n+1},(_,i)=>{const r=new Float32Array(m+1);r[0]=i;return r;});
  for(let j=0;j<=m;j++)d[0][j]=j;
  for(let i=1;i<=n;i++)for(let j=1;j<=m;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(x[i-1]===y[j-1]?0:1));
  return Math.max(0,1-d[n][m]/Math.max(n,m));
}
export function alignUtterances(script, utterances, { profile = 'prose' } = {}) {
  if (profile.startsWith('toeic-')) return toeicAlignment(script, utterances, profile);
  if (script.length * utterances.length > 250000) return toeicAlignment(script, utterances, 'toeic-talk');
  // Monotone alignment; unrecognised audio and missing script lines are permitted.
  // Only strong, locally unique matches are proposed, never extrapolated timestamps.
  const N=script.length,M=utterances.length;
  if(!N||!M)return [];
  const dp=new Float32Array((N+1)*(M+1));const back=new Uint8Array(dp.length);
  const at=(i,j)=>i*(M+1)+j;
  for(let i=1;i<=N;i++){dp[at(i,0)]=dp[at(i-1,0)]-.025;back[at(i,0)]=1;}
  for(let j=1;j<=M;j++){dp[at(0,j)]=dp[at(0,j-1)]-.35;back[at(0,j)]=2;}
  for(let i=1;i<=N;i++)for(let j=1;j<=M;j++){
    const s=similarity(script[i-1].text,utterances[j-1].text);
    let best=dp[at(i-1,j)]-.025,op=1;
    const skip=dp[at(i,j-1)]-.35;if(skip>best){best=skip;op=2;}
    // A match must beat skipping the audio; low similarity must never force a match.
    if(s>=.65){const v=dp[at(i-1,j-1)]+2*s-.65;if(v>best){best=v;op=3;}}
    dp[at(i,j)]=best;back[at(i,j)]=op;
  }
  const proposed=[];let i=N,j=M;
  while(i>0&&j>0){const op=back[at(i,j)];if(op===3){const s=similarity(script[i-1].text,utterances[j-1].text);proposed.push({scriptIndex:i-1,utteranceIndex:j-1,score:s});i--;j--;}else if(op===1)i--;else j--;}
  proposed.reverse();
  return proposed.filter(p=>{
    if(p.score<.86)return false;
    const u=utterances[p.utteranceIndex];
    // Avoid treating the same word inside a longer sentence as a standalone word.
    if(words(script[p.scriptIndex].text).length===1 && words(u.text).length!==1)return false;
    const competitors=script.reduce((n,s,k)=>n+(k!==p.scriptIndex&&similarity(s.text,u.text)>=p.score-.04?1:0),0);
    // Duplicate sentences are inherently ambiguous without independent anchors.
    return competitors===0;
  });
}

// TOEIC scripts may include speaker labels and a paragraph may span several VAD regions.
function toeicAlignment(script, utterances, profile) {
  const clean = text => String(text || '').replace(/^(?:(?:speaker\s+)?[mfwabMFWAB]\d*|(?:speaker|woman|man)\s*\d*|[A-Z][a-z]+):\s*/, '').replace(/^\([A-D]\)\s*/i, '');
  const keys = script.map(row => words(clean(row.text)).join(' '));
  const byFirst = new Map();
  keys.forEach((key, i) => {
    const first = key.split(' ')[0];
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push(i);
  });
  const maxPieces = profile === 'toeic-talk' ? 24 : profile === 'toeic-mixed' ? 16 : 6;
  const maxGap = profile === 'toeic-talk' ? 2.5 : 1.2;
  const candidates = [];
  for (let i = 0; i < utterances.length; i++) {
    const first = utterances[i];
    let combined = '';
    for (let j = i; j < Math.min(utterances.length, i + maxPieces); j++) {
      const last = utterances[j];
      if (j > i && (last.start - utterances[j - 1].end > maxGap || last.start < utterances[j - 1].end)) break;
      const piece = words(clean(last.text)).join(' ');
      if (!piece) break;
      combined = combined ? combined + ' ' + piece : piece;
      const possible = byFirst.get(combined.split(' ')[0]) || [];
      if (!possible.some(k => keys[k] === combined || keys[k].startsWith(combined + ' '))) break;
      for (const k of possible) if (keys[k] === combined) {
        candidates.push({ scriptIndex:k, utteranceIndex:i, last:j, score:1,
          range:{ sourceId:first.sourceId, start:first.start, end:last.end } });
      }
    }
  }
  // Unique matches provide anchors for repeated answers such as “Yes.”
  const counts = new Map(), audioCounts = new Map();
  for (const proposal of candidates) {
    const { scriptIndex, utteranceIndex, last } = proposal;
    const span = `${utteranceIndex}:${last}`;
    counts.set(scriptIndex, (counts.get(scriptIndex) || 0) + 1);
    audioCounts.set(span, (audioCounts.get(span) || 0) + 1);
  }
  const anchors = candidates.filter(p => counts.get(p.scriptIndex) === 1 &&
    audioCounts.get(`${p.utteranceIndex}:${p.last}`) === 1);
  const selected = [];
  let index = -1, last = -1;
  for (const p of anchors) {
    if (p.scriptIndex <= index || p.utteranceIndex <= last) continue;
    selected.push(p); index = p.scriptIndex; last = p.last;
  }
  const resolved = [...selected];
  for (let i = 0; i <= selected.length; i++) {
    const left = selected[i - 1], right = selected[i];
    const possible = candidates.filter(p => p.scriptIndex > (left?.scriptIndex ?? -1) &&
      p.scriptIndex < (right?.scriptIndex ?? keys.length) && p.utteranceIndex > (left?.last ?? -1) &&
      p.last < (right?.utteranceIndex ?? utterances.length));
    const unique = possible.filter(p => !possible.some(q => q !== p &&
      (q.scriptIndex === p.scriptIndex || (q.utteranceIndex <= p.last && q.last >= p.utteranceIndex))));
    let boundary = left?.scriptIndex ?? -1;
    for (const p of unique) if (p.scriptIndex > boundary) { resolved.push(p); boundary = p.scriptIndex; }
  }
  return resolved.sort((a, b) => a.scriptIndex - b.scriptIndex);
}
