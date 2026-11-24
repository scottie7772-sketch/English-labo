import { db } from './db.js';

// Shared blobs are retained if any material still points to them.
export async function releaseVideoMedia(ids) {
  const removed = new Set(ids);
  const videos = await db.all('videos');
  const retained = new Set(videos.filter(v => !removed.has(v.id) && v.mediaRef).map(v => v.mediaRef));
  const keys = new Set(ids.filter(id => !retained.has(id)));
  for (const v of videos) if (removed.has(v.id) && v.mediaRef && !retained.has(v.mediaRef)) keys.add(v.mediaRef);
  // 1.19.31: a recording that a word card still uses stays (as 単語帳の音声); only the material is removed
  const { protectReferenced } = await import('./audio-refs.js');
  const { remove } = await protectReferenced([...keys], 'vblobs');
  const { releaseLabRefs } = await import('./studio-db.js');
  await releaseLabRefs(remove);
  return remove;
}
