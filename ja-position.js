// Local draft only: no audio, timestamps or cue identifiers are modified.
export function adjustJaRows(values,i,j,swap=false,start=0,end=0){
  if(i<0||j<0||i>=values.length||j>=values.length||Math.abs(i-j)!==1)return null;
  const next=values.slice();
  if(swap){[next[i],next[j]]=[next[j],next[i]];return next;}
  const text=values[i]; if(!text.trim())return null;
  if(start===end){start=0;end=text.length;}
  const part=text.slice(start,end);if(!part.trim())return null;
  next[i]=text.slice(0,start)+text.slice(end);
  next[j]=j<i?values[j]+part:part+values[j];
  return next;
}
