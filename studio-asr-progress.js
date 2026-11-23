// A compact per-material record. The remaining block in IndexedDB is the
// authoritative resume cursor; this record only detects repeated interruption.
export function beginAsrStage(previous, {key,stage,...detail}) {
  const same = previous?.key === key;
  const attempt = same ? previous.attempt+1 : 1;
  return {key,stage,...detail,attempt,at:Date.now()};
}
export function asrRetryBlocked(previous,key) {
  return previous?.key === key && previous.attempt >= 2;
}

export function asrWindows(start,end,length=25) {
  const windows=[];
  for (let a=start;a<end-.015;) {
    const b=Math.min(end,a+length);
    windows.push([a,b]);
    a=b;
  }
  return windows;
}
