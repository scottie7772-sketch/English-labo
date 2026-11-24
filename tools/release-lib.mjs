// Release manifest helpers (no dependencies). Used by build-release.mjs, check-release.mjs and the tests.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Files that are served by the app and pre-cached by the service worker. Tests (*.mjs), docs, zips, sw.js and release.json are not.
export const SHIP_EXT = /\.(js|css|html|json|png|webmanifest)$/;
export const NOT_SHIPPED = new Set(['sw.js', 'release.json']);
export const BEGIN = '// BEGIN GENERATED (tools/build-release.mjs) - do not edit by hand';
export const END = '// END GENERATED';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const shippedFiles = (root) => fs.readdirSync(root)
  .filter((f) => fs.statSync(path.join(root, f)).isFile() && SHIP_EXT.test(f) && !NOT_SHIPPED.has(f) && !/\s/.test(f))
  .sort();

export function constants(root) {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const app = read('app-version.js').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
  const studio = read('studio-main.js').match(/STUDIO_VERSION\s*=\s*'([^']+)'/)?.[1];
  if (!app || !studio) throw new Error('APP_VERSION / STUDIO_VERSION が読み取れません');
  return { version: app, studio };
}

// The id changes whenever any shipped byte changes. The service worker names its cache after it, so a new release
// can never be written into the cache that pages of the previous release are still reading from.
export const releaseId = (files) => sha256(Object.entries(files).map(([n, h]) => `${n}:${h}\n`).join('')).slice(0, 12);

export function buildRelease(root) {
  const files = Object.fromEntries(shippedFiles(root).map((f) => [f, sha256(fs.readFileSync(path.join(root, f)))]));
  const { version, studio } = constants(root);
  return { version, studio, id: releaseId(files), files };
}

export function swBlock(release) {
  return `${BEGIN}\nconst RELEASE = ${JSON.stringify(release.id)};\nconst CACHE = 'ell-shell-' + RELEASE;\nconst FILES = ${JSON.stringify(release.files)};\n${END}`;
}
export function applyToSw(swSource, release) {
  const a = swSource.indexOf(BEGIN), b = swSource.indexOf(END);
  if (a < 0 || b < a) throw new Error('sw.js に生成ブロックの目印がありません');
  return swSource.slice(0, a) + swBlock(release) + swSource.slice(b + END.length);
}
export function parseSw(swSource) {
  const a = swSource.indexOf(BEGIN), b = swSource.indexOf(END);
  if (a < 0 || b < a) return null;
  const block = swSource.slice(a, b);
  return { id: JSON.parse(block.match(/const RELEASE = (".*?");/)[1]), files: JSON.parse(block.match(/const FILES = (\{.*\});/)[1]) };
}
export const stringify = (release) => JSON.stringify(release, null, 2) + '\n';
