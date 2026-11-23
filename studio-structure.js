// Offline, bounded speech-region analysis. No ASR, network, media copies or persistence.
export function speechRegions(audio, rate = 16000, { gapFrames = 9, minGap = .18 } = {}) {
  if (!audio?.length || !rate) return [];
  const hop = Math.max(1, Math.round(rate * .02));
  const rms = [];
  for (let i=0;i<audio.length;i+=hop) {
    let power=0; const end=Math.min(audio.length,i+hop);
    for(let j=i;j<end;j++){const v=audio[j];power+=v*v;}
    rms.push(Math.sqrt(power/(end-i)));
  }
  const sorted=Float32Array.from(rms).sort();
  const at=q=>sorted[Math.min(sorted.length-1,Math.floor(q*(sorted.length-1)))];
  const noise=at(.2), peak=at(.95);
  if (peak < .002 || peak < noise * 1.7) return [];
  const threshold=Math.max(.002,noise*2.7,peak*.105);
  const raw=[]; let first=-1, last=-1;
  for(let i=0;i<rms.length;i++) {
    if(rms[i]>=threshold) {if(first<0)first=i;last=i;}
    else if(first>=0 && i-last>gapFrames) {raw.push([first,last+1]);first=-1;}
  }
  if(first>=0)raw.push([first,last+1]);
  // Short internal gaps (<180 ms) belong to the same spoken utterance.
  const merged=[];
  for(const [a,b] of raw) {
    if(merged.length && (a-merged.at(-1)[1])*.02<minGap)merged.at(-1)[1]=b;
    else merged.push([a,b]);
  }
  return merged.map(([a,b])=>({start:+Math.max(0,a*.02-.035).toFixed(2),end:+Math.min(audio.length/rate,b*.02+.035).toFixed(2)}))
    .filter(x=>x.end-x.start>=.16);
}
export function regionStatistics(regions) {
  const gaps=[];for(let i=1;i<regions.length;i++)gaps.push(regions[i].start-regions[i-1].end);
  const median=a=>a.length?[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]:null;
  return {count:regions.length,medianGap:median(gaps),medianDuration:median(regions.map(r=>r.end-r.start)),
    repeats:regions.slice(0,-1).filter((r,i)=>{const a=r.end-r.start,b=regions[i+1].end-regions[i+1].start;return a>.6&&Math.abs(a-b)<.12}).length};
}
// Only refine independently text-matched ASR candidates. Never infer speech content from energy.
export function snapCueToRegion(cue, regions) {
  const nearby=regions.map(r=>({r,d:Math.abs(r.start-cue.start)+Math.abs(r.end-cue.end)}))
    .filter(x=>Math.abs(x.r.start-cue.start)<.55 && Math.abs(x.r.end-cue.end)<.65)
    .sort((a,b)=>a.d-b.d);
  if(!nearby.length || (nearby[1] && nearby[1].d-nearby[0].d<.18))return null;
  return nearby[0].r;
}

// MA scan: RMS proposes activity. Modulation and changes in zero-crossing
// rate distinguish voice-like material from steady tones; text is separate evidence.
export function maSpeechActivity(audio, sourceId, offset = 0) {
  return speechRegions(audio).map(region => {
    const levels=[], crossings=[];
    const first=Math.max(0,Math.floor(region.start*16000));
    const last=Math.min(audio.length,Math.floor(region.end*16000));
    for (let i=first;i+320<=last;i+=320) {
      let power=0, z=0;
      for (let j=i;j<i+320;j++) {
        power+=audio[j]**2;
        if (j>i && (audio[j]>=0)!==(audio[j-1]>=0)) z++;
      }
      levels.push(Math.sqrt(power/320)); crossings.push(z/320);
    }
    const spread = values => {
      const a=values.slice().sort((x,y)=>x-y);
      const lo=a[Math.floor(a.length*.2)]||0, hi=a[Math.floor(a.length*.8)]||0;
      return {delta:hi-lo,hi};
    };
    const rms=spread(levels), zcr=spread(crossings);
    const voice = levels.length>=8 && rms.delta>rms.hi*.15 && zcr.delta>=.009;
    return {sourceId,start:+(region.start+offset).toFixed(3),end:+(region.end+offset).toFixed(3),voice};
  });
}
