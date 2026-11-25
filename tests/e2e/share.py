"""Browser test of the backup Share fix.

Share is hidden where Chromium would refuse the file; a refusal elsewhere is
explained and hides the button; Save the file still works and restores; a
closed share sheet changes nothing; a successful share records the backup.
navigator.share is replaced in each case, so nothing leaves the test browser.
"""
import os, re, signal, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from harness import CHROME, ROOT, build, dist

SHOTS = Path(sys.argv[1]); SHOTS.mkdir(exist_ok=True)
PORT = 4199; URL = f"http://localhost:{PORT}/"
FAKE_SHARE = """
(() => {
  const mode = '%s';
  window.__shares = 0;
  if (mode !== 'chromium') Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true });
  navigator.canShare = () => true;
  navigator.share = () => {
    window.__shares++;
    if (mode === 'refuse') return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    if (mode === 'cancel') return Promise.reject(new DOMException('Share canceled', 'AbortError'));
    return Promise.resolve();
  };
})();
"""

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok))); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")

server = subprocess.Popen(["npx", "vite", "preview", "--outDir", dist(), "--port", str(PORT), "--strictPort"],
                          cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
time.sleep(3)
try:
    with sync_playwright() as p:
        def open_backup(mode):
            ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), executable_path=CHROME, headless=True,
                                                       viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
            ctx.add_init_script(FAKE_SHARE % mode)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)[:200]))
            page.goto(URL); page.click("nav >> text=Settings")
            page.click("text=Make a backup"); page.wait_for_selector("button:has-text('Save the file')")
            return ctx, page, errors

        backup_status = lambda page: page.locator("section:has(#backup) p[role=status]")
        last_backup = lambda page: page.locator("text=Last backup:").inner_text()
        share_buttons = lambda page: page.locator("button:has-text('Share')").count()

        # ---- A. Chromium (Chrome, Samsung Internet): canShare() says yes, but Share is not offered
        ctx, page, errors = open_backup("chromium")
        brands = page.evaluate("navigator.userAgentData?.brands?.map(b => b.brand).join(', ')")
        check("chromium: browser reports the Chromium brand", "Chromium" in (brands or ""), brands or "none")
        check("chromium: canShare() is faked to say yes", page.evaluate("navigator.canShare({ files: [new File(['x'], 'a.sqlite')] })"))
        check("chromium: Save the file is offered", page.locator("button:has-text('Save the file')").is_visible())
        check("chromium: Share is not offered", share_buttons(page) == 0)
        page.screenshot(path=str(SHOTS / "share-a-chromium.png"), full_page=True)
        check("chromium: no page errors", not errors, "; ".join(errors)); ctx.close()

        # ---- B. A browser that offers Share, then refuses the file
        ctx, page, errors = open_backup("refuse")
        check("refuse: Share is offered", share_buttons(page) == 1)
        page.click("button:has-text('Share')")
        page.wait_for_selector("text=does not allow sharing this kind of file")
        status = backup_status(page).inner_text()
        check("refuse: the refusal is explained", status == "This phone does not allow sharing this kind of file. Use “Save the file” instead.", status)
        check("refuse: Share is hidden after the refusal", share_buttons(page) == 0)
        check("refuse: Save the file is still offered", page.locator("button:has-text('Save the file')").is_visible())
        check("refuse: share() was called once", page.evaluate("window.__shares") == 1)
        check("refuse: no backup recorded yet", "never" in last_backup(page), last_backup(page))
        page.screenshot(path=str(SHOTS / "share-b-refused.png"), full_page=True)
        with page.expect_download() as info: page.click("button:has-text('Save the file')")
        download = info.value
        check("save: file is named by date", re.fullmatch(r"household-backup-\d{4}-\d{2}-\d{2}\.sqlite", download.suggested_filename), download.suggested_filename)
        saved = Path(tempfile.mkdtemp()) / download.suggested_filename; download.save_as(saved)
        check("save: file is a SQLite database", saved.read_bytes()[:16] == b"SQLite format 3\x00", f"{saved.stat().st_size} bytes")
        page.wait_for_selector("text=to this phone's downloads")
        status = backup_status(page).inner_text()
        check("save: message says where the file went and how it opens",
              status == f"Saved {download.suggested_filename} to this phone's downloads. Copy it somewhere other than this phone, "
                        "such as Google Drive or a computer. It opens only in this app, with Restore below.", status)
        check("save: backup recorded", "never" not in last_backup(page), last_backup(page))
        page.screenshot(path=str(SHOTS / "share-c-saved.png"), full_page=True)
        page.set_input_files("input[type=file]", str(saved))
        page.click("button:has-text('Restore')"); page.click("text=Tap again")
        page.wait_for_selector("text=/Restored \\d+ titles?\\./")
        check("save: the saved file restores", True, page.locator("text=/Restored \\d+ titles?\\./").inner_text())
        check("refuse/save: no page errors", not errors, "; ".join(errors)); ctx.close()

        # ---- C. A browser where sharing works
        ctx, page, errors = open_backup("ok")
        page.click("button:has-text('Share')")
        page.wait_for_selector("text=/^Shared household-backup-/")
        status = backup_status(page).inner_text()
        check("share: message after sharing", re.fullmatch(r"Shared household-backup-\d{4}-\d{2}-\d{2}\.sqlite\. Keep a copy somewhere other than this phone\. "
                                                           r"It opens only in this app, with Restore below\.", status) is not None, status)
        check("share: backup recorded", "never" not in last_backup(page), last_backup(page))
        check("share: no page errors", not errors, "; ".join(errors)); ctx.close()

        # ---- D. The share sheet is closed without sharing
        ctx, page, errors = open_backup("cancel")
        page.click("button:has-text('Share')"); page.wait_for_function("window.__shares === 1"); page.wait_for_timeout(300)
        check("cancel: no message", backup_status(page).count() == 0)
        check("cancel: both buttons stay", share_buttons(page) == 1 and page.locator("button:has-text('Save the file')").is_visible())
        check("cancel: no backup recorded", "never" in last_backup(page), last_backup(page))
        check("cancel: no page errors", not errors, "; ".join(errors)); ctx.close()
finally:
    os.killpg(server.pid, signal.SIGTERM)

passed = sum(ok for _, ok in results)
print(f"\n{passed} of {len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
