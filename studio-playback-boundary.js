// Playback-only boundary padding for speech-first alignment.
// Never mutates stored segments or manually edited timings.
export function speechFirstPlaybackRange(block, segment, allBlocks, duration = Infinity) {
  if (!block || !segment || block.sync === 'manual' ||
      block.structureAlign?.method !== 'speech-first') return null;
  const start = Number(segment.start), end = Number(segment.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const others = (allBlocks || []).filter(b => b && b.id !== block.id && !b.deleted)
    .flatMap(b => b.segments || []).filter(s => s.sourceId === segment.sourceId &&
      Number.isFinite(s.start) && Number.isFinite(s.end));
  const previousEnd = Math.max(0, ...others.filter(s => s.end <= start).map(s => s.end));
  const nextStart = Math.min(duration, ...others.filter(s => s.start >= end).map(s => s.start));
  // For adjacent blocks, never enter the neighbour's saved interval.
  const paddedStart = Math.max(0, previousEnd, start - 0.18);
  const paddedEnd = Math.min(duration, nextStart, end + 0.06);
  return { start: Math.min(start, paddedStart), end: Math.max(end, paddedEnd) };
}

// Continuous playback is uninterrupted within a source. Find the next source
// following its last assigned segment in the current contiguous run.
export function nextSourceSegment(order, byId, playing, sourceId) {
  const start = order.indexOf(playing.b.id);
  if (start < 0) return null;
  // Walk in subtitle order, skipping no-audio rows and the exhausted source.
  // This preserves the imported file sequence represented by the script list.
  for (let index = start; index < order.length; index++) {
    const b = byId[order[index]];
    if (!b || !Array.isArray(b.segments)) continue;
    for (let i = index === start ? playing.i + 1 : 0; i < b.segments.length; i++) {
      const segment = b.segments[i];
      if (segment?.sourceId && segment.sourceId !== sourceId) return {b,i};
    }
  }
  return null;
}
