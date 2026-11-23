import { words } from './studio-align.js';
import { createRescueSearch } from './studio-prose-rescue.js';

export const maScriptRow = b => !b.deleted && Boolean(b.text?.trim()) && (!b.asr || b.aligned || b.sync === 'manual');
const key = s => words(s).map(w => w.w).join(' ');
const intersects = (a,b) => a.sourceId === b.sourceId && a.start < b.end && b.start < a.end;
const valid = g => g && Number.isFinite(g.start) && Number.isFinite(g.end) && g.end-g.start >= .12 && g.start >= 0;
const round = n => +n.toFixed(3);

export function maTextScore(script, heard) {
  const a = key(script).split(' '), b = key(heard).split(' ');
  if (!a[0] || !b[0]) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  if (Math.min(a.length,b.length) < 5 || Math.abs(a.length-b.length) > 2 || a.length > 180 || b.length > 180) return 0;
  const d = new Uint16Array(b.length+1);
  for (const w of a) {
    let diagonal = 0;
    for (let i=1;i<=b.length;i++) {
      const old = d[i];
      d[i] = w === b[i-1] ? diagonal+1 : Math.max(d[i],d[i-1]);
      diagonal = old;
    }
  }
  // Full-utterance support on both sides; a short matching prefix is not enough.
  return a[0] === b[0] && a.at(-1) === b.at(-1) ? d[b.length]/Math.max(a.length,b.length) : 0;
}

export function freeMaSegments(range, occupied, minimum = .12) {
  const cut = occupied.filter(g => intersects(range,g)).sort((a,b) => a.start-b.start);
  let cursor = range.start;
  const out = [];
  for (const g of cut) {
    if (g.start > cursor && g.start-cursor >= minimum) out.push({...range,start:cursor,end:g.start});
    cursor = Math.max(cursor,g.end);
  }
  if (range.end-cursor >= minimum) out.push({...range,start:cursor});
  return out;
}

export function maBoundaryIssues(row, positions, previous, current) {
  const tags = [];
  if (row.sync === 'manual') tags.push('手動確認済み');
  if (!current) return tags.concat('未割当');
  if (row.sync === 'estimated' || row.endEst) tags.push('時間推定のみ');
  const n = words(row.text).length;
  const length = row.segments.reduce((s,g)=>s+g.end-g.start,0);
  if (n >= 3 && length < n/7) tags.push('極端に短い');
  if (n && length > Math.max(5,n*1.5)) tags.push('極端に長い');
  if (positions.has(row.id)) tags.push('重複');
  if (previous && (previous.rank > current.rank ||
      previous.rank === current.rank && previous.start > current.start+.12)) tags.push('時刻逆転');
  return tags;
}

export function maConflicts(blocks, proposals, sourceIds = []) {
  const replacements = new Map(proposals.map(p=>[p.row.id,p]));
  const rows = blocks.filter(maScriptRow);
  const ranks = new Map(sourceIds.map((sid,i)=>[sid,i]));
  const bySource = new Map(), conflicts = new Map();
  const report = (a,b,reason) => {
    if (replacements.has(a.row.id) && !conflicts.has(a.row.id))
      conflicts.set(a.row.id,{row:a.row,segment:a.segment,other:b?.row,otherSegment:b?.segment,reason});
  };
  const compare = (a,b) => (ranks.get(a.segment.sourceId)??0)-(ranks.get(b.segment.sourceId)??0) ||
    (a.segment.sourceId===b.segment.sourceId ? a.segment.start-b.segment.start : 0);
  const wrongOrder = (a,b) => {
    if (a.segment.sourceId===b.segment.sourceId) return a.segment.start>b.segment.start+.12;
    return ranks.has(a.segment.sourceId) && ranks.has(b.segment.sourceId) && compare(a,b)>0;
  };
  const records=rows.map(row=>{
    const proposal=replacements.get(row.id);
    if (proposal && (row.sync==='manual'||!valid(proposal.segment))) report({row,segment:proposal.segment},null,'手動確認済み、または無効な区間');
    const spans=(proposal && !conflicts.has(row.id) ? [proposal.segment] : row.segments).map(segment=>({row,segment}));
    for (const x of spans) {
      const sid=x.segment.sourceId;
      if (!bySource.has(sid)) bySource.set(sid,[]);
      bySource.get(sid).push(x);
    }
    return spans;
  });
  for (const list of bySource.values()) {
    list.sort((a,b)=>a.segment.start-b.segment.start);
    let first,second;
    for (const x of list) {
      const other=first?.row.id===x.row.id ? second : first;
      if (other && intersects(other.segment,x.segment)) {
        report(x,other,'既存の音声区間と重複');
        report(other,x,'既存の音声区間と重複');
      }
      if (!first || x.segment.end>first.segment.end) {
        if (first?.row.id!==x.row.id) second=first;
        first=x;
      } else if (first.row.id!==x.row.id && (!second||x.segment.end>second.segment.end)) second=x;
    }
  }
  for (const dir of [1,-1]) {
    let edge;
    for (let i=dir===1 ? 0 : records.length-1; i>=0 && i<records.length; i+=dir) {
      for (const span of records[i]) {
        if (edge && (dir===1 ? wrongOrder(edge,span) : wrongOrder(span,edge)))
          report(span,edge,'スクリプト順と時刻順が逆転');
      }
      for (const span of records[i]) if (!edge || dir*compare(span,edge)>0) edge=span;
    }
  }
  return [...conflicts.values()];
}

export function planMaAudit(blocks, sourceIds, sources, analysis = {}) {
  const rows = blocks.filter(maScriptRow);
  const ranks = new Map(sourceIds.map((s,i)=>[s,i]));
  const order = (a,b) => (ranks.get(a.sourceId) ?? 0)-(ranks.get(b.sourceId) ?? 0) || a.start-b.start;
  const before = (a,b) => a && b && order({...a,start:a.end},b) <= .0001;
  const all = new Map(sourceIds.map(sid=>[sid,[]])), overlapping = new Set();
  rows.forEach(row=>row.segments.forEach(g=>all.get(g.sourceId)?.push({...g,row})));
  for (const list of all.values()) {
    list.sort(order);
    let last;
    for (const g of list) {
      if (last && g.row.id !== last.row.id && intersects(last,g) && Math.min(last.end,g.end)-g.start > .12) {
        overlapping.add(last.row.id); overlapping.add(g.row.id);
      }
      if (!last || g.end > last.end) last=g;
    }
  }

  let previous;
  const entries = rows.map(row=>{
    const current = row.segments[0];
    const clock = current && {...current,rank:ranks.get(current.sourceId)};
    const tags = maBoundaryIssues(row,overlapping,previous,clock);
    if (clock) previous = clock;
    return {row,current,tags,proposal:null};
  });

  const evidence = [];
  for (const row of blocks) {
    const g = row.segments[0];
    if (row.asr && !row.deleted && row.segments.length === 1 && valid(g) && row.text?.trim())
      evidence.push({...g,text:row.text,estimated:row.sync==='estimated'||row.asrBoundaryEstimated});
  }
  const seenEvidence = new Map();
  const remember = cue => {
    const k=cue.sourceId+'\n'+key(cue.text);
    if (!seenEvidence.has(k)) seenEvidence.set(k,[]);
    seenEvidence.get(k).push(cue);
  };
  evidence.filter(cue=>!cue.estimated).forEach(remember);
  for (const data of Object.values(analysis)) for (const cue of data.cues || []) {
    const previous=seenEvidence.get(cue.sourceId+'\n'+key(cue.text)) || [];
    if (previous.some(old=>Math.abs(old.start-cue.start)<.3 && Math.abs(old.end-cue.end)<.4)) continue;
    evidence.push(cue);
    remember(cue);
  }
  evidence.sort(order);
  const byExact = new Map(), byEnds = new Map();
  const add = (map,k,cue) => { if (!map.has(k)) map.set(k,[]); map.get(k).push(cue); };
  for (const cue of evidence) {
    const k = key(cue.text), ws = k.split(' ');
    if (!k) continue;
    add(byExact,k,cue);
    if (ws.length >= 5) add(byEnds,ws[0]+' '+ws.at(-1),cue);
  }
  const unique = new Map();
  for (const entry of entries) {
    const k = key(entry.row.text);
    unique.set(k,(unique.get(k)||0)+1);
  }
  const protectedRows = entries.map((x,i)=>({x,i})).filter(({x}) =>
    x.current && (x.row.sync === 'manual' || (x.row.aligned && !x.tags.length)));
  const durations = new Map(sourceIds.map(sid=>[sid,sources[sid]?.duration || (all.get(sid)||[]).reduce((n,g)=>Math.max(n,g.end),0)]));
  for (const cue of evidence) if (!sources[cue.sourceId]?.duration)
    durations.set(cue.sourceId,Math.max(durations.get(cue.sourceId)||0,cue.end));
  const audioDuration = sid => durations.get(sid) || 0;
  const activity = sid => analysis[sid]?.regions || [];
  const trustworthyActivity = sid => activity(sid).filter(g=>g.voice);
  const speechFits = (cue,region) => region.start <= cue.start+.45 && region.end >= cue.end-.45 &&
    region.end-region.start <= (cue.end-cue.start)*1.65+.5 && intersects(cue,region);

  function padded(cue) {
    const regions = trustworthyActivity(cue.sourceId);
    const nearby = regions.filter(g=>speechFits(cue,g));
    const d = audioDuration(cue.sourceId) || cue.end;
    const r = nearby.length === 1 ? nearby[0] : null;
    const start = r ? Math.max(0,r.start-.07) : cue.start;
    const end = r ? Math.min(d,r.end+.09) : Math.min(d,cue.end);
    return {segment:{sourceId:cue.sourceId,start:round(start),end:round(end)}, acoustic:Boolean(r)};
  }

  // Candidates stay in script order. One exact occurrence may be used once,
  // and repeated rows need ordered neighbours or equal occurrence counts.
  const matched = new Map();
  let left = null, next = 0;
  for (let i=0;i<entries.length;i++) {
    const e = entries[i], {row,current} = e;
    while (next < protectedRows.length && protectedRows[next].i <= i) next++;
    const right = protectedRows[next]?.x.current;
    if (row.sync === 'manual') { left=row.segments.at(-1)||left; continue; }
    const k=key(row.text), ws=k.split(' ');
    const leftLimit = left, inWindow = cue => {
      if (current) {
        if (current.sourceId !== cue.sourceId || row.segments.length !== 1) return false;
        if (Math.max(current.start-cue.end,cue.start-current.end) > 3) return false;
      }
      return (!leftLimit || before(leftLimit,cue)) && (!right || before(cue,right));
    };
    const exact = (byExact.get(k)||[]).filter(c=>!c.estimated&&inWindow(c));
    const approximate = exact.length || ws.length<6 ? [] : (byEnds.get(ws[0]+' '+ws.at(-1))||[])
      .filter(c=>!c.estimated&&inWindow(c)&&maTextScore(row.text,c.text)>=.9);
    const hits = (exact.length ? exact : approximate).filter(g=>ranks.has(g.sourceId));
    let cue;
    if (hits.length===1 && (current || unique.get(k)===1 || (leftLimit && right))) cue=hits[0];
    if (hits.length>1 && !current && leftLimit && right) {
      let remaining=0;
      for (let j=i;j<(protectedRows[next]?.i ?? entries.length);j++) if (key(entries[j].row.text)===k) remaining++;
      if (remaining===hits.length) cue=hits[0];
    }
    if (cue && !cue.estimated) {
      const result=padded(cue);
      if (valid(result.segment)) {
        const score=maTextScore(row.text,cue.text);
        matched.set(i,result.segment);
        left=result.segment;
        const change=!current || Math.abs(current.start-result.segment.start)>.15 || Math.abs(current.end-result.segment.end)>.15 || row.sync==='estimated';
        if (change) e.proposal={row, ...result, score, high:score===1 && result.acoustic, reason:result.acoustic?'全文ASR一致・発話境界あり':score===1?'全文ASR一致・境界はASR時刻':'ASR高一致・要試聴'};
        if (current && change) {
          e.tags.push('境界要確認');
          if (current.start<result.segment.start-.15) e.tags.push('冒頭の余白');
          if (current.start>result.segment.start+.15) e.tags.push('文頭の欠け');
          if (current.end<result.segment.end-.15) e.tags.push('文末の欠け');
          if (current.end>result.segment.end+.15) e.tags.push('文末の余白・次の発話');
        }
        continue;
      }
    }
    if (current && row.aligned && !e.tags.length) left=current;
  }

  // If text recognition failed, use bounded speech activity between two
  // known neighbours. It provides a review hypothesis only, not text evidence.
  const groups = createRescueSearch(blocks,sourceIds,sources,{includeEstimated:true});
  const byId = new Map(entries.map((e,i)=>[e.row.id,i]));
  const pending = e=>e.row.sync!=='manual' && (!e.current || e.row.segments.length===1 &&
    (e.row.sync==='estimated' || e.tags.some(tag=>['極端に短い','極端に長い','重複','時刻逆転'].includes(tag))));
  const protectedSpans=entries.flatMap(e=>e.row.sync==='manual' ||
    (e.current && !pending(e) && !e.proposal) ? e.row.segments : []);
  for (let i=0;i<entries.length;i++) {
    if (!pending(entries[i]) || entries[i].proposal) continue;
    let j=i; while (j+1<entries.length && pending(entries[j+1]) && !entries[j+1].proposal) j++;
    const group=groups.byRow.get(entries[i].row.id);
    const leftIndex=group?.before.trusted ? byId.get(group.before.trusted.row.id) : undefined;
    const rightIndex=group?.after.trusted ? byId.get(group.after.trusted.row.id) : undefined;
    const neighbour = (index,fallback) => {
      const e=entries[index];
      return matched.get(index) || ((e?.row.sync==='manual'|| e?.current && e.row.aligned && !e.tags.length) ? e.current : fallback);
    };
    const lo=neighbour(i-1,matched.get(leftIndex)||group?.before.trusted);
    const hi=neighbour(j+1,matched.get(rightIndex)||group?.after.trusted);
    if (lo && hi && lo.sourceId===hi.sourceId && hi.start>lo.end && hi.start-lo.end<=60) {
      const sid=lo.sourceId;
      const free=freeMaSegments({sourceId:sid,start:lo.end,end:hi.start},protectedSpans);
      const regions=trustworthyActivity(sid).filter(g=>free.some(f=>g.start>=f.start && g.end<=f.end));
      if (regions.length===j-i+1 && regions.every((g,k)=>!k || g.start>=regions[k-1].end)) {
        regions.forEach((g,k)=>{
          const e=entries[i+k], bounds=free.find(f=>g.start>=f.start && g.end<=f.end);
          const n=words(e.row.text).length, d=g.end-g.start;
          if (d < Math.max(.2,n/9) || d > Math.max(3,n*1.3)) return;
          if (e.current && e.current.sourceId!==sid) return;
          e.proposal={row:e.row,segment:{sourceId:sid,start:round(Math.max(bounds.start,regions[k-1]?.end||0,g.start-.06)),
            end:round(Math.min(bounds.end,regions[k+1]?.start??Infinity,g.end+.08))},
          acoustic:true,score:0,high:false,reason:'前後アンカー・発話数・順序が一致（本文未確認）'};
        });
      }
    }
    i=j;
  }

  const proposals=entries.flatMap(e=>e.proposal?[e.proposal]:[]);
  const conflicted = new Map();
  for (const conflict of maConflicts(blocks,proposals,sourceIds)) {
    if (!conflicted.has(conflict.row.id)) conflicted.set(conflict.row.id,conflict);
  }
  for (const e of entries) {
    e.conflict=conflicted.get(e.row.id);
    if (e.current && e.tags.some(tag=>!['手動確認済み','時間推定のみ'].includes(tag)) && !e.tags.includes('境界要確認')) {
      e.tags.push('境界要確認');
    }
    if (e.current && !e.proposal && activity(e.current.sourceId).some(g=>g.voice &&
        ((g.start<e.current.start-.18 && g.end>e.current.start+.18) ||
         (g.end>e.current.end+.18 && g.start<e.current.end-.18)))) e.tags.push('発話境界をまたぐ');
  }
  const unused=[];
  for (const sid of sourceIds) {
    const d=audioDuration(sid);
    if (!d) continue;
    const free=freeMaSegments({sourceId:sid,start:0,end:d},all.get(sid)||[],.25);
    for (const g of free) {
      const hits=activity(sid).filter(r=>r.voice && intersects(r,g))
        .map(r=>({...r,start:Math.max(r.start,g.start),end:Math.min(r.end,g.end)})).filter(valid);
      if (hits.length) unused.push(...hits.map(segment=>({segment,reason:'未使用区間の発話候補'})));
      else if (evidence.some(r=>intersects(r,g))) unused.push({segment:g,reason:'未使用区間に保存済みASRあり'});
      else unused.push({segment:g,reason:'未使用区間・発話未確認'});
    }
  }
  return {entries,unused};
}
