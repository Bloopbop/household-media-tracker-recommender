"""Browser test of combining two phones' data.

Two separate browser profiles stand in for the S24 and the iPhone. A backup
from the first is edited with Python's sqlite3 to make the two phones'
copies differ (hand-written rows only), then each phone restores its copy
and combines the other's backup through Settings. Checks the preview, the
result in the library, combining twice, a wrong file, and the combined
backups themselves.
"""
import shutil, sqlite3, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from harness import CHROME, ROOT, build, dist

SHOTS = Path(sys.argv[1]); SHOTS.mkdir(exist_ok=True)
DIST = dist()
PORT = 4199; URL = f"http://localhost:{PORT}/"
T0 = 1_763_000_000_000
LATER = T0 + 86_400_000

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok))); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}", flush=True)

server = subprocess.Popen(["npx", "vite", "preview", "--outDir", DIST, "--port", str(PORT), "--strictPort"],
                          cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
time.sleep(3)
work = Path(tempfile.mkdtemp())
try:
    with sync_playwright() as p:
        def phone():
            ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), executable_path=CHROME, headless=True,
                                                       viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)[:200]))
            page.goto(URL); page.wait_for_selector("nav")
            return ctx, page, errors

        def backup(page, name):
            page.click("nav >> text=Settings"); page.click("text=Make a backup")
            with page.expect_download() as info: page.click("button:has-text('Save the file')")
            target = work / name; info.value.save_as(target); return target

        def restore(page, file):
            page.click("nav >> text=Settings")
            page.set_input_files("section:has(#backup) .panel:has-text('Restore from a backup file') input[type=file]", str(file))
            page.click("button:has-text('Restore')"); page.click("button:has-text('Tap again')")
            page.wait_for_selector("text=/Restored \\d+ title/")

        def combine(page, file):
            page.click("nav >> text=Settings")
            page.set_input_files("#combine input[type=file]", str(file))
            page.wait_for_function("() => !document.querySelector('#combine')?.textContent?.includes('Reading the backup')")
            return page.inner_text("#combine")

        # ---- 1. The S24 makes the household's backup; both phones start from it
        s24, s24_page, s24_errors = phone()
        base = backup(s24_page, "base.sqlite")
        db = sqlite3.connect(base)
        db.executescript(f"""
            UPDATE profile SET name = 'Alex' WHERE id = 'A';
            UPDATE profile SET name = 'Sam' WHERE id = 'B';
            INSERT INTO title (id, kind, name, year, tmdb_id, source, created_at, updated_at) VALUES
              ('t1', 'movie', 'Shared Film', 2001, 101, 'vault', {T0}, {T0}),
              ('t2', 'movie', 'Disputed Film', 2002, 102, 'vault', {T0}, {T0});
            INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES
              ('US', 't1', 8, {T0}, 'vault'), ('US', 't2', 7, {T0}, 'vault');
            INSERT INTO title_state (profile_id, title_id, status, would_rewatch, updated_at) VALUES
              ('A', 't1', 'watched', 0, {T0}), ('B', 't1', 'watched', 0, {T0});
        """)
        db.commit(); db.close()
        s24_copy = work / "s24.sqlite"; iphone_copy = work / "iphone.sqlite"
        shutil.copy(base, s24_copy); shutil.copy(base, iphone_copy)

        # What each phone does on its own afterwards
        db = sqlite3.connect(iphone_copy)
        db.executescript(f"""
            INSERT INTO title (id, kind, name, year, tmdb_id, source, created_at, updated_at) VALUES
              ('i1', 'movie', 'Sam Found This', 2020, 500, 'slate', {LATER}, {LATER});
            INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES
              ('B', 'i1', 9.5, {LATER}, 'slate'), ('B', 't1', 6, {LATER}, 'manual');
            INSERT INTO title_state (profile_id, title_id, status, would_rewatch, updated_at) VALUES ('B', 'i1', 'watched', 0, {LATER});
            UPDATE rating SET score = 5, rated_at = {LATER} WHERE rater = 'US' AND title_id = 't2';
            INSERT INTO signal (id, at, mode, type, title_key, title_id, slate_id, rank, session, arm) VALUES
              ('sig1', {LATER}, 'B', 'seen', 'movie:500', 'i1', 'slate-i', 3, 'iphone', 'reviews'),
              ('sig2', {LATER}, 'B', 'impression', 'movie:500', NULL, 'slate-i', 3, 'iphone', 'reviews');
        """)
        db.commit(); db.close()
        db = sqlite3.connect(s24_copy)
        db.executescript(f"""
            UPDATE rating SET score = 9, rated_at = {LATER + 60_000} WHERE rater = 'US' AND title_id = 't2';
            INSERT INTO title (id, kind, name, year, tmdb_id, source, created_at, updated_at) VALUES
              ('s1', 'series', 'Alex Found This', 2019, 700, 'search', {LATER}, {LATER});
            INSERT INTO title_state (profile_id, title_id, status, would_rewatch, updated_at) VALUES ('A', 's1', 'watchlist', 0, {LATER});
        """)
        db.commit(); db.close()

        restore(s24_page, s24_copy)
        iphone, iphone_page, iphone_errors = phone()
        restore(iphone_page, iphone_copy)

        # ---- 2. The S24 combines the iPhone's backup
        text = combine(s24_page, iphone_copy)
        check("preview: says what combining adds", "1 new title, 2 ratings, 1 status and 1 reaction to a pick" in text, text.splitlines()[1] if "\n" in text else text)
        check("preview: nothing deleted, said plainly", "Nothing on this phone is deleted" in text)
        s24_page.screenshot(path=str(SHOTS / "merge-preview.png"), full_page=True)
        s24_page.click("#combine button:has-text('Combine')"); s24_page.wait_for_selector("#combine >> text=Combined: added")
        done = s24_page.inner_text("#combine p[role=status]")
        check("combine: reports what it added", done.startswith("Combined: added 1 new title"), done)
        check("combine: counts updated", "4 titles and" in s24_page.inner_text("section:has(#backup)"), s24_page.locator("section:has(#backup) p.small").first.inner_text())

        s24_page.click("nav >> text=Library"); s24_page.wait_for_selector(".grid li")
        check("library: the iPhone's title is on the S24", s24_page.locator(".grid li:has-text('Sam Found This')").count() == 1)
        s24_page.click(".grid li:has-text('Shared Film')"); s24_page.wait_for_selector("h1:has-text('Shared Film')")
        ratings = s24_page.inner_text("section:has(h2:has-text('Ratings'))")
        check("library: Sam's own rating from the iPhone arrived", "6" in ratings and "Sam" in ratings, " ".join(ratings.split())[:120])
        s24_page.click("nav >> text=Library"); s24_page.click(".grid li:has-text('Disputed Film')"); s24_page.wait_for_selector("h1:has-text('Disputed Film')")
        disputed = s24_page.inner_text("section:has(h2:has-text('Ratings'))")
        check("library: the later shared rating stays (the S24's 9, not the iPhone's earlier 5)", "9" in disputed and " 5" not in disputed, " ".join(disputed.split())[:120])

        text = combine(s24_page, iphone_copy)
        check("again: nothing new the second time", "Nothing new: this phone already has everything" in text)
        check("again: no Combine button", s24_page.locator("#combine button:has-text('Combine')").count() == 0)

        junk = work / "notes.txt"; junk.write_text("not a backup")
        text = combine(s24_page, junk)
        check("wrong file: explained", "This file is not a household backup." in text)

        # ---- 3. The other way round: the iPhone combines the S24's new backup
        s24_after = backup(s24_page, "s24-after.sqlite")
        text = combine(iphone_page, s24_after)
        check("iphone preview: the S24's title and status", "1 new title" in text and "status" in text, text.splitlines()[1] if "\n" in text else text)
        iphone_page.click("#combine button:has-text('Combine')"); iphone_page.wait_for_selector("#combine >> text=Combined: added")
        iphone_after = backup(iphone_page, "iphone-after.sqlite")

        # ---- 4. Both phones now hold the same household
        def snapshot(path):
            db = sqlite3.connect(path)
            data = {
                "titles": sorted(db.execute("SELECT id, kind, tmdb_id FROM title").fetchall()),
                "ratings": sorted(db.execute("SELECT rater, title_id, score FROM rating").fetchall()),
                "states": sorted(db.execute("SELECT profile_id, title_id, status FROM title_state").fetchall()),
                "signals": sorted(db.execute("SELECT id FROM signal").fetchall()),
                "dupes": db.execute("SELECT COUNT(*) FROM (SELECT kind, tmdb_id FROM title WHERE tmdb_id IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1)").fetchone()[0],
                "fk": db.execute("PRAGMA foreign_key_check").fetchall(),
            }
            db.close(); return data
        a = snapshot(backup(s24_page, "s24-final.sqlite")); b = snapshot(iphone_after)
        check("both: same titles, ratings, statuses and signals", all(a[k] == b[k] for k in ("titles", "ratings", "states", "signals")),
              f"{len(a['titles'])}/{len(b['titles'])} titles, {len(a['ratings'])}/{len(b['ratings'])} ratings")
        check("both: everything from both phones", len(a["titles"]) == 4 and len(a["ratings"]) == 4 and len(a["signals"]) == 2, str(a["ratings"]))
        check("both: no duplicate titles, no broken links", a["dupes"] == 0 and b["dupes"] == 0 and not a["fk"] and not b["fk"])
        check("no page errors", not s24_errors and not iphone_errors, "; ".join(s24_errors + iphone_errors))
        s24.close(); iphone.close()
finally:
    import os, signal as sig
    os.killpg(os.getpgid(server.pid), sig.SIGTERM)

passed = sum(ok for _, ok in results)
print(f"{passed} of {len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
