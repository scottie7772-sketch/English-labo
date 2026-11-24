#!/usr/bin/env node
// Verifies that release.json, the generated block of sw.js, the version constants and the real files all agree,
// and that every module / stylesheet / icon the app loads is part of the release. Exit code 1 on any problem.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease, parseSw, shippedFiles } from './release-lib.mjs';

export function checkRelease(root) {
  const problems = [];
  const built = buildRelease(root);
  let rel = null; try { rel = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8')); } catch { problems.push('release.json を読めません'); }
  if (rel) {
    for (const k of ['version', 'studio', 'id']) if (rel[k] !== built[k]) problems.push(`release.json の ${k} が実ファイルと違います（${rel[k]} ≠ ${built[k]}）`);
    for (const [n, h] of Object.entries(built.files)) if (rel.files?.[n] !== h) problems.push(`release.json のハッシュが違います: ${n}`);
    for (const n of Object.keys(rel.files || {})) if (!built.files[n]) problems.push(`release.json に余分なファイル: ${n}`);
  }
  const sw = parseSw(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'));
  if (!sw) problems.push('sw.js に生成ブロックがありません');
  else {
    if (sw.id !== built.id) problems.push(`sw.js の RELEASE が違います（${sw.id} ≠ ${built.id}）`);
    for (const [n, h] of Object.entries(built.files)) if (sw.files[n] !== h) problems.push(`sw.js のハッシュが違います: ${n}`);
    for (const n of Object.keys(sw.files)) if (!built.files[n]) problems.push(`sw.js に余分なファイル: ${n}`);
  }
  // every relative module the app can load must be pre-cached and hash-checked
  const shipped = new Set(shippedFiles(root)), ref = /(?:from\s+|import\s+|import\s*\(\s*|importScripts\s*\(\s*)['"]\.\/([^'"?#]+)/g;
  for (const f of shipped) {
    if (!f.endsWith('.js')) continue;
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(ref)) if (!shipped.has(m[1])) problems.push(`${f} が読み込む ${m[1]} がリリースに含まれていません`);
  }
  for (const f of ['index.html', 'studio.html']) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/(?:src|href)="\.?\/?([^"#:]+\.(?:js|css|png|webmanifest))"/g)) if (!shipped.has(m[1])) problems.push(`${f} が参照する ${m[1]} がリリースに含まれていません`);
  }
  // both launch paths must run the update manager
  if (!/initUpdate\s*\(/.test(fs.readFileSync(path.join(root, 'studio.html'), 'utf8'))) problems.push('studio.html が initUpdate() を呼んでいません');
  if (!/initUpdate\s*\(/.test(fs.readFileSync(path.join(root, 'app.js'), 'utf8'))) problems.push('app.js が initUpdate() を呼んでいません');
  return { problems, release: built };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { problems, release } = checkRelease(root);
  if (problems.length) { console.error('release check FAILED:\n- ' + problems.join('\n- ') + '\n→ node tools/build-release.mjs で再生成してください'); process.exit(1); }
  console.log(`release check ok: ${release.version} / studio ${release.studio} / id ${release.id} / ${Object.keys(release.files).length} files`);
}
