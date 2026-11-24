#!/usr/bin/env node
// Regenerates release.json and the generated block of sw.js from the files in the repository root.
// Run after changing any shipped file:  node tools/build-release.mjs     (the GitHub workflow does this automatically)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease, applyToSw, stringify } from './release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = buildRelease(root);
const swPath = path.join(root, 'sw.js'), relPath = path.join(root, 'release.json');
const sw = applyToSw(fs.readFileSync(swPath, 'utf8'), release);
const changed = [];
if (fs.readFileSync(swPath, 'utf8') !== sw) { fs.writeFileSync(swPath, sw); changed.push('sw.js'); }
const json = stringify(release);
if (!fs.existsSync(relPath) || fs.readFileSync(relPath, 'utf8') !== json) { fs.writeFileSync(relPath, json); changed.push('release.json'); }
console.log(`release ${release.version} / studio ${release.studio} / id ${release.id} / ${Object.keys(release.files).length} files` + (changed.length ? ` -> updated ${changed.join(', ')}` : ' (already up to date)'));
