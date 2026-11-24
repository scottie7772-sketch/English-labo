#!/usr/bin/env python3
"""Chromium integration test with generated audio, subtitles, and vocabulary."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from time import perf_counter
import os
from playwright.sync_api import expect, sync_playwright

root = Path(__file__).resolve().parent.parent
with ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(root))) as server:
    Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=os.getenv("CHROMIUM", "/usr/bin/chromium"),
            args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
        )
        page = browser.new_page(service_workers="block")
        page.route("**/*", lambda route: route.continue_() if route.request.url.startswith("http://127.0.0.1:") else route.abort())
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        base = f"http://127.0.0.1:{server.server_port}/"
        page.goto(base + "#ma-phrases")
        page.locator('[name="csv"]').set_input_files({
            "name": "synthetic.csv", "mimeType": "text/csv",
            "buffer": b"id,phrase,meaning,priority,example_en,chapter\n"
                      b"one,turn back,return,1,Please turn back before the bridge now.,1\n"
                      b"two,back,reverse,2,Please turn back before the bridge now.,1\n"
                      b"three,set aside,reserve,3,She set aside some money for the train.,1\n",
        })
        page.get_by_role("button", name="端末に登録").click()
        page.get_by_text("3件を登録・更新しました。", exact=False).wait_for()
        page.evaluate("""async () => {
          const { db } = await import('./db.js');
          const { buildMaterial } = await import('./studio-main.js');
          const { sdb, newBlock } = await import('./studio-db.js');
          const { writeMaterialPack, readMaterialImport } = await import('./material-pack.js');
          const { importMaterial } = await import('./video.js');
          const rate = 8000, samples = 32000;
          const wav = new Uint8Array(44 + samples * 2);
          const view = new DataView(wav.buffer);
          for (const [pos, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) {
            wav.set(new TextEncoder().encode(text), pos);
          }
          for (const [pos, value] of [[4, wav.length - 8], [16, 16], [24, rate], [28, rate * 2], [40, samples * 2]]) view.setUint32(pos, value, true);
          for (const [pos, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(pos, value, true);
          for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(4000 * Math.sin(2 * Math.PI * 440 * i / rate)), true);
          const blob = new Blob([wav], { type: 'audio/wav' });
          const id = 'synthetic';
          await sdb.put('sources', { id, kind: 'audio', mime: blob.type, name: 'recording.wav', size: blob.size, duration: 4, stored: true, blob });
          const block = newBlock('set', { text: 'Please turn back before the bridge now.', ja: '翻訳の表示確認', aligned: true,
            segments: [{ sourceId: id, start: 0.5, end: 3 }] });
          const second = newBlock('set', { text: 'She set aside some money for the train.', aligned: true,
            segments: [{ sourceId: id, start: 3.1, end: 3.9 }] });
          await sdb.put('blocks', block);
          await sdb.put('blocks', second);
          const set = { id: 'set', folder: '', title: 'Untitled recording', materialType: 'prose', order: [block.id, second.id] };
          await sdb.put('sets', set);
          const { manifest, material, media } = await buildMaterial(set);
          const zip = await writeMaterialPack(manifest, material, new Map(media.map(m => [m.id, m.blob])));
          const entry = await readMaterialImport(zip);
          await importMaterial(entry.manifest, entry.material, entry.getFile, { askUpdate: false, archive: true });
          const [v] = await db.all('videos');
          window.videoId = v.id;
          window.clips = [];
          document.addEventListener('playing', e => {
            if (e.target.muted) return;
            window.clips.push({ start: e.target.currentTime, src: e.target.currentSrc });
          }, true);
          // The reused word audio element is detached, so observe it through play as well.
          const play = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function () {
            return play.call(this).then(() => {
              if (!this.muted && this.currentSrc.startsWith('blob:')) window.clips.push({ start: this.currentTime, src: this.currentSrc });
            });
          };
        }""")
        video_id = page.evaluate("videoId")
        page.goto(base + "#video-play?id=" + video_id)
        page.locator("#openSet").click()
        expect(page.locator("#maResult")).to_have_text("音声と照合できた使用例 3件（自動判定: 1）", timeout=5000)
        page.locator("#maOn").uncheck()
        assert page.locator("#cl .ma-mark").count() == 0
        page.locator("#maOn").check()
        page.locator('#maSet [data-ma-level="1"]').uncheck()
        page.locator("#shSet [data-shclose]").click()
        page.locator("#cl .ma-mark", has_text="back").wait_for()
        assert page.locator("#cl .ma-mark").first.inner_text() == "back"
        page.locator("#openSet").click()
        page.locator('#maSet [data-ma-level="1"]').check()
        page.locator("#shSet [data-shclose]").click()
        page.get_by_text("翻訳の表示確認", exact=True).first.wait_for()
        page.locator("#cl .ma-mark", has_text="turn back").click()
        page.get_by_text("フレーズ単体の時刻は未確定").wait_for()
        t0 = perf_counter()
        page.get_by_role("button", name="▶ 使用例").click()
        page.wait_for_function("clips.some(x => x.start >= .49 && x.start < .7)")
        print(f"example_click_to_playing_ms={(perf_counter() - t0)*1000:.1f}")
        page.get_by_role("link", name="単語帳で開く").click()
        page.get_by_text("フレーズの境界を調整").click()
        page.locator('[data-edge="start"]').fill("1.1")
        page.locator('[data-edge="end"]').fill("1.7")
        page.get_by_role("button", name="境界を確定").click()
        page.get_by_role("button", name="▶ フレーズ").click()
        page.wait_for_function("clips.some(x => x.start >= 1.09 && x.start < 1.3)")
        assert not errors, errors
        print("PASS MA import, Studio ZIP transfer, highlight controls, original example and phrase playback")
        browser.close()
