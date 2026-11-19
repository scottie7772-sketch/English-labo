// Material pack (ELPack) helpers: file fingerprint, uncompressed ZIP writer/reader (no external library).
// Large files are processed in chunks so a 15-minute video never has to be held in memory at once.

// ---------- fingerprint: size + SHA-256 of the first and last 1 MB (fast, low memory) ----------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function fingerprint(file) {
  const MB = 1 << 20;
  const head = await crypto.subtle.digest('SHA-256', await file.slice(0, MB).arrayBuffer());
  const tail = await crypto.subtle.digest('SHA-256', await file.slice(Math.max(0, file.size - MB)).arrayBuffer());
  const h = hex(head), t = hex(tail);
  return { id: `fp_${h.slice(0, 16)}${t.slice(0, 8)}_${file.size}`, size: file.size, head: h, tail: t };
}

// ---------- CRC32 (chunked) ----------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export async function crc32(blob, onProgress) {
  let c = 0xffffffff; const CH = 4 << 20;
  for (let off = 0; off < blob.size; off += CH) {
    const b = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer());
    for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    onProgress?.(Math.min(1, (off + CH) / blob.size));
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- ZIP writer (method 0 = stored). files: [{ name, data: Blob | string }] ----------
export async function zipWrite(files, onProgress) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0, done = 0;
  const total = files.reduce((a, f) => a + (typeof f.data === 'string' ? f.data.length : f.data.size), 0) || 1;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const blob = typeof f.data === 'string' ? new Blob([f.data]) : f.data;
    if (blob.size > 0xfffffff0) throw new Error(`${f.name} は大きすぎます（4GBまで）`);
    const name = enc.encode(f.name);
    const crc = await crc32(blob, (p) => onProgress?.((done + p * blob.size) / total));
    done += blob.size;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, blob.size, true); lh.setUint32(22, blob.size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, blob.size, true); ch.setUint32(24, blob.size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + blob.size;
  }
  const cdSize = central.reduce((a, p) => a + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---------- ZIP reader: returns { names, file(name) -> Blob, text(name) } (stored; deflate via DecompressionStream) ----------
export async function zipRead(blob) {
  const tailLen = Math.min(blob.size, 66000);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIPファイルとして読めません');
  const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const entries = {};
  for (let p = 0, n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('ZIPの目次が壊れています');
    const method = cd.getUint16(p + 10, true), csize = cd.getUint32(p + 20, true), size = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true), lho = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nlen));
    entries[name] = { method, csize, size, lho };
    p += 46 + nlen + xlen + clen;
  }
  async function file(name) {
    const e = entries[name]; if (!e) return null;
    const lh = new DataView(await blob.slice(e.lho, e.lho + 30).arrayBuffer());
    const start = e.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = blob.slice(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8 && 'DecompressionStream' in window) return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    throw new Error(`${name} は対応していない圧縮形式です`);
  }
  return { names: Object.keys(entries), file, async text(name) { const b = await file(name); return b ? b.text() : null; } };
}
