import { zipRead, zipWrite } from './common-pack.js';

const mediaExtension = {
  'audio/mp4':'.m4a', 'audio/x-m4a':'.m4a', 'audio/m4a':'.m4a', 'audio/aac':'.aac',
  'audio/mpeg':'.mp3', 'audio/mp3':'.mp3', 'audio/wav':'.wav', 'audio/x-wav':'.wav',
  'audio/webm':'.webm', 'audio/ogg':'.ogg', 'audio/flac':'.flac', 'audio/aiff':'.aiff',
  'video/mp4':'.mp4', 'video/quicktime':'.mov', 'video/webm':'.webm', 'video/x-m4v':'.m4v',
};

export function packMedia(source, blob) {
  const blobType = blob?.type?.split(';')[0].toLowerCase();
  const mime = /^(audio|video)\//.test(blobType || '') ? blobType : source.mime;
  const kind = /^(audio|video)\//.test(mime || '') ? mime.split('/')[0] : source.kind;
  const ext = mediaExtension[mime] || source.name?.match(/\.\w+$/)?.[0] || (kind === 'video' ? '.mp4' : '.m4a');
  return {
    id: source.id, name: source.name, kind, mime, size: blob?.size ?? source.size, duration: source.duration,
    head: source.head, tail: source.tail, trackIndex: source.audio?.index,
    included: Boolean(blob), path: blob ? `media/${encodeURIComponent(source.id)}${ext}` : null,
  };
}

export function materialPackEntries(manifest, material, files) {
  const included = material.media.filter(media => media.included);
  const missing = included.find(media => !media.path || !(files.get(media.id)?.size > 0) || files.get(media.id).size !== media.size);
  if (missing) throw Error(`音声を保存できません（${missing.name || missing.id}）。元のファイルを選び直してください。`);
  if (manifest.contents.audioMode === 'all' && (!included.length || included.length !== material.media.length)) {
    throw Error('音声がそろっていないため、音声付きパックを作成できません');
  }
  return [
    {name:'manifest.json', data:JSON.stringify(manifest)},
    {name:'material.json', data:JSON.stringify(material)},
    ...included.map(media => ({name:media.path, data:files.get(media.id)})),
  ];
}

export async function writeMaterialPack(manifest, material, files, onProgress) {
  const zip = await zipWrite(materialPackEntries(manifest, material, files), onProgress);
  const check = await zipRead(zip);
  if (material.media.some(media => media.included && check.entrySize(media.path) !== media.size)) {
    throw Error('書き出したパックの音声を確認できませんでした');
  }
  return zip;
}

async function readZipMaterialPack(zip, prefix = '', manifest = null) {
  if (!zip.names.includes(prefix + 'manifest.json') || !zip.names.includes(prefix + 'material.json')) {
    throw Error('Englabo教材パックの情報がありません。スタジオで作成した .elpack.zip を選んでください。英日対応データはスタジオで取り込めます。');
  }
  manifest ||= JSON.parse(await zip.text(prefix + 'manifest.json'));
  const material = JSON.parse(await zip.text(prefix + 'material.json'));
  if (manifest?.format !== 'elpack' || manifest.formatVersion > 2 || !material?.set ||
      !Array.isArray(material.media) || !Array.isArray(material.items)) {
    throw Error('対応していない教材パックです');
  }
  if ((manifest.contents?.audioMode === 'all' || manifest.contents?.audio) && !material.media.some(media => media.included)) {
    throw Error('パック内に音声がありません。スタジオから音声付きで書き出し直してください。');
  }
  const ids = new Set(material.media.map(media => media.id));
  if (material.items.some(item => item.segments?.some(segment => !ids.has(segment.media)))) {
    throw Error('パックに字幕が参照する音声情報がありません。スタジオから書き出し直してください。');
  }
  for (const media of material.media) {
    if (!media.included) {
      if (manifest.contents?.audioMode === 'all') throw Error(`パックに音声が入っていません（${media.name || media.id}）`);
      continue;
    }
    const size = zip.entrySize(prefix + media.path);
    if (!(size > 0) || (media.size > 0 && size !== media.size)) {
      throw Error(`パック内の音声が欠けています（${media.name || media.id}）。スタジオから音声付きで書き出し直してください。`);
    }
  }
  return {
    manifest, material,
    async getFile(media) {
      if (!media.included) return null;
      const blob = await zip.file(prefix + media.path);
      if (!blob?.size || blob.size !== zip.entrySize(prefix + media.path)) throw Error(`パック内の音声が壊れています（${media.name || media.id}）`);
      return blob;
    },
  };
}

export async function readMaterialPack(file) {
  return readZipMaterialPack(await zipRead(file));
}

const memberPrefix = index => `materials/${index + 1}/`;

export async function writeMaterialCollection(title, members, onProgress) {
  if (!members.length) throw Error('書き出せる教材がありません');
  return zipWrite([
    { name:'manifest.json', data:JSON.stringify({format:'elpack-collection',formatVersion:1,title,materials:members.map(member => member.title)}) },
    ...members.flatMap((member, index) => member.entries.map(entry => ({ ...entry, name:memberPrefix(index) + entry.name }))),
  ], onProgress);
}

export async function readMaterialImport(file) {
  const zip = await zipRead(file);
  const manifest = JSON.parse(await zip.text('manifest.json'));
  if (manifest?.format !== 'elpack-collection') return readZipMaterialPack(zip, '', manifest);
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.materials) || !manifest.materials.length ||
      !manifest.materials.every(title => typeof title === 'string')) throw Error('対応していない一括教材パックです');
  return { title:manifest.title, entries:manifest.materials.map((title, index) =>
    ({ title, read:() => readZipMaterialPack(zip, memberPrefix(index)) })) };
}
