#!/usr/bin/env node
// Runs every *.mjs test. The tests import app modules as "../x.js", so they are copied next to a symlinked view of the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'englabo-tests-'));
fs.mkdirSync(path.join(tmp, 'tests'));
for (const f of fs.readdirSync(root)) {
  const full = path.join(root, f);
  if (f.endsWith('.mjs')) fs.copyFileSync(full, path.join(tmp, 'tests', f));
  else if (!/\s/.test(f) && f !== 'node_modules') fs.symlinkSync(full, path.join(tmp, f));
}
const tests = fs.readdirSync(path.join(tmp, 'tests')).filter((f) => f.endsWith('.mjs') && f !== 'fake-idb.mjs').sort();
const only = process.argv.slice(2);
let failed = 0;
for (const t of tests.filter((t) => !only.length || only.some((o) => t.includes(o)))) {
  const r = spawnSync(process.execPath, [t], { cwd: path.join(tmp, 'tests'), encoding: 'utf8', timeout: 300000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t}${ok ? '' : '\n' + (r.stderr || r.stdout).split('\n').slice(-12).join('\n')}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test file(s) failed` : `\nall ${tests.length} test files passed`);
process.exit(failed ? 1 : 0);
