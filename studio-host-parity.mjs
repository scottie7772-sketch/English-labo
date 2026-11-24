// Launch-path parity guard: the standalone Studio (studio.html) and the Studio inside Englabo run the SAME studio-main.js.
// Only three things may depend on the host: the back/exit link, "register in the Lab" and "send words to the vocabulary".
// Any other `HOST` use in studio-main.js fails here, so a feature can no longer exist in one launch path only by accident.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../studio-main.js', import.meta.url), 'utf8').split('\n');
const ALLOWED = [
  /\bHOST\s*=\s*(null|host)\b/,                                   // declaration / mount()
  /HOST\?\.exitHref|'__exit'/,                                     // back button (host-specific)
  /sendToLab|studioLabState|syncStudioLabFolder/,                  // register in Video Lab (host-specific)
  /addWordsCsv|訳をつけたCSVを単語帳へ|下に貼り付けて単語帳へ/,        // vocabulary hand-off (host-specific)
  /value="send">英語ラボに送る/,                                     // Lab hand-off button (host-specific)
];
const offenders = src.map((line, i) => [i + 1, line]).filter(([, l]) => /\bHOST\b/.test(l) && !ALLOWED.some((re) => re.test(l)));
assert.deepEqual(offenders.map(([n, l]) => `${n}: ${l.trim().slice(0, 120)}`), [], 'HOST が共有機能の出し分けに使われています。共通機能は起動経路に関係なく出してください');

// both HTML entry points load the same module graph and the same update manager
const root = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
assert.match(root('studio.html'), /from '\.\/studio-main\.js'/);
assert.match(root('app.js'), /import\('\.\/studio-main\.js'\)/);
assert.match(root('studio.html'), /initUpdate\(\)/);
assert.match(root('app.js'), /initUpdate\(\)/);
// the layout rule that only existed in studio.html is applied inside Englabo as well
assert.match(root('app.js'), /classList\.toggle\('studio', route === 'studio'\)/);
// no second copy of the studio can be left behind
assert.deepEqual(fs.readdirSync(new URL('..', import.meta.url)).filter((f) => /^studio-main.+\.js$/.test(f)), []);
console.log('studio-host-parity: ok (' + src.filter((l) => /\bHOST\b/.test(l)).length + ' host-specific lines, all allowed)');
