"""Browser test of the phase 1 build with hand-written sample responses.

Starts from a phase 0 database (as on the phones), upgrades it, then walks the
main flows: add, rate, status, notes, watchlist, offline stub, find-it link,
backup without keys, restore, the six-month purge and relink, and removal.
"""
import base64, json, os, re, signal, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from harness import CHROME, ROOT, build, dist

SHOTS = Path(sys.argv[1]); SHOTS.mkdir(exist_ok=True)
PORT = 4199; URL = f"http://localhost:{PORT}/"
# The last phase 0 version, for the upgrade test: merge of pull request #2.
PHASE0 = "ecaf6c8"
CORS = {"access-control-allow-origin": "*"}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
MOVIE = {"id": 101, "title": "Sample Film", "original_title": "Sample Film", "release_date": "2004-03-19", "overview": "A made-up film used only for testing.",
         "poster_path": "/film.png", "runtime": 108, "genres": [{"name": "Drama"}, {"name": "Romance"}], "vote_average": 8.1, "vote_count": 1234,
         "original_language": "en", "production_countries": [{"iso_3166_1": "US"}], "status": "Released",
         "credits": {"cast": [{"name": "Pat Lead", "character": "X", "order": 0}], "crew": [{"name": "Dee Rector", "job": "Director"}]},
         "keywords": {"keywords": [{"name": "memory"}]}, "external_ids": {"imdb_id": "tt0000101"},
         "recommendations": {"results": []}, "similar": {"results": []},
         "watch/providers": {"results": {"CA": {"flatrate": [{"provider_id": 8, "provider_name": "Stream Co", "logo_path": "/logo.png"}]}}}}
SHOW = {"id": 202, "name": "Sample Show", "original_name": "Sample Show", "first_air_date": "2002-06-02", "last_air_date": "2008-03-09", "overview": "A made-up series.",
        "poster_path": "/show.png", "episode_run_time": [55], "genres": [{"name": "Crime"}], "vote_average": 8.6, "vote_count": 99, "original_language": "en",
        "origin_country": ["US"], "created_by": [{"name": "Cree Ator"}], "status": "Ended", "number_of_seasons": 5, "number_of_episodes": 60,
        "credits": {"cast": []}, "keywords": {"results": []}, "external_ids": {"imdb_id": "tt0000202"}, "recommendations": {"results": []},
        "similar": {"results": []}, "watch/providers": {"results": {}}}
SEARCH = {"results": [{"media_type": "movie", "id": 101, "title": "Sample Film", "release_date": "2004-03-19", "poster_path": "/film.png", "popularity": 9},
                      {"media_type": "tv", "id": 202, "name": "Sample Show", "first_air_date": "2002-06-02", "poster_path": "/show.png", "popularity": 8},
                      {"media_type": "person", "id": 303, "name": "Some Person"}]}
OMDB = {"Response": "True", "imdbRating": "8.3", "imdbVotes": "12,345", "Metascore": "74",
        "Ratings": [{"Source": "Internet Movie Database", "Value": "8.3/10"}, {"Source": "Rotten Tomatoes", "Value": "93%"}, {"Source": "Metacritic", "Value": "74/100"}]}
calls = {"tmdb": 0, "omdb": 0, "find": 0}

def mock(ctx):
    def j(route, body, status=200):
        route.fulfill(status=status, headers={**CORS, "content-type": "application/json"}, body=json.dumps(body))
    def tmdb(route):
        calls["tmdb"] += 1
        url = route.request.url
        if "/search/" in url: return j(route, SEARCH if "query=Nothing" not in url else {"results": []})
        if "/discover/" in url or "/trending/" in url: return j(route, {"results": []})  # phase 2 gathers candidates
        if "/movie/" in url: return j(route, MOVIE)  # phase 0 asks for a different id; same sample
        if "/tv/202" in url: return j(route, SHOW)
        if "/find/tt0000101" in url:
            calls["find"] += 1; return j(route, {"movie_results": [{"id": 101}], "tv_results": []})
        if "/find/tt0000202" in url:
            calls["find"] += 1; return j(route, {"movie_results": [], "tv_results": [{"id": 202}]})
        return j(route, {"status_message": "not found"}, 404)
    def omdb(route):
        calls["omdb"] += 1; j(route, OMDB)
    ctx.route("https://api.themoviedb.org/**", tmdb)
    ctx.route("https://www.omdbapi.com/**", omdb)
    ctx.route("https://api.tvmaze.com/**", lambda r: j(r, {"id": 1, "_embedded": {"episodes": [1]}}))
    ctx.route("https://image.tmdb.org/**", lambda r: r.fulfill(status=200, headers={**CORS, "content-type": "image/png"}, body=PNG))

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok))); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")

def serve(outdir):
    proc = subprocess.Popen(["npx", "vite", "preview", "--outDir", outdir, "--port", str(PORT), "--strictPort"],
                            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(3); return proc

profile = tempfile.mkdtemp()
with sync_playwright() as p:
    def launch():
        ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
                                                   viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
        mock(ctx)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" and "probe" not in m.text and "ERR_INTERNET_DISCONNECTED" not in m.text else None)
        return ctx, page, errors

    # ---- 1. A phase 0 device: keys entered, a few launches
    server = serve(build(PHASE0))
    ctx, page, errors = launch()
    page.goto(URL); page.wait_for_selector("li.pass:has-text('Database opens')")
    page.fill("input[type=password] >> nth=0", "sample-tmdb-key"); page.fill("input[type=password] >> nth=1", "sample-omdb-key")
    page.fill("input[type=text]", "CA"); page.click("text=Run online checks"); page.wait_for_selector("img.poster", timeout=15000)
    page.reload(); page.wait_for_selector("li.pass:has-text('Database opens')"); page.wait_for_timeout(500)
    print("DEBUG phase 0 after reload: keys =", [page.locator("input[type=password]").nth(i).input_value() for i in range(2)])
    launches_before = int(re.sub(r"\D", "", page.inner_text(".launch")))
    ctx.close(); os.killpg(server.pid, signal.SIGTERM); server.wait(); time.sleep(1)

    # ---- 2. Upgrade to phase 1
    server = serve(dist())
    ctx, page, errors = launch()
    page.goto(URL)
    # The installed old version opens first; the new one installs and reloads the page once.
    for _ in range(20):
        page.wait_for_timeout(1500)
        try:
            if page.locator("nav.tabs").count() == 1 and page.evaluate("navigator.serviceWorker.controller?.scriptURL || ''").endswith('sw.js'):
                page.wait_for_timeout(2000)
                if page.locator("nav.tabs").count() == 1: break
        except Exception:
            pass  # the page reloaded mid-check
    page.wait_for_selector("h1:has-text('For you')", timeout=20000)
    check("upgrade: app opens on For you (phase 2's launch view)", page.locator("button.mode").count() == 3)
    page.click("nav >> text=Settings")
    page.wait_for_selector("h1:has-text('Settings')")
    print("DEBUG url", page.url, "pw inputs:", page.locator("input[type=password]").count(), [page.locator("input[type=password]").nth(i).input_value() for i in range(page.locator("input[type=password]").count())])
    page.screenshot(path=str(SHOTS / "debug-settings.png"), full_page=True)
    check("upgrade: keys carried over", page.input_value("input[type=password] >> nth=0") == "sample-tmdb-key" and page.input_value("input[type=password] >> nth=1") == "sample-omdb-key")
    check("upgrade: country carried over", page.input_value("label.short input") == "CA")
    page.click("text=Device check"); page.wait_for_selector(".launch")
    launches_after = int(re.sub(r"\D", "", page.inner_text(".launch")))
    check("upgrade: launch count continues", launches_after >= launches_before + 1, f"{launches_before} -> {launches_after}")
    check("upgrade: earlier device-check results kept", page.locator("li.pass", has_text="TMDB reachable").count() == 1)

    # ---- 3. Names
    page.click("nav >> text=Settings")
    page.fill("text=First person >> xpath=.. >> input", "Sam"); page.fill("text=Second person >> xpath=.. >> input", "Alex")
    page.click("text=Save names"); page.wait_for_selector("text=Saved.")

    # ---- 4. Add a movie watched together, agreed rating 8.5
    page.click("nav >> text=Library"); page.click("a:has-text('Add')")
    page.fill("input[type=search]", "Sample"); page.wait_for_selector("button.result")
    check("search: people dropped from results", page.locator("button.result").count() == 2)
    page.click("button.result:has-text('Sample Film')"); page.click("text=Watched it")
    page.click("fieldset:has-text('Your agreed rating') button[aria-label='8']"); page.click("text=+½")
    page.click("form.watched button[type=submit]")
    page.wait_for_selector("h1:has-text('Sample Film')")
    page.wait_for_selector("text=Rotten Tomatoes", timeout=10000)
    rows = page.locator("section:has(h2:has-text('Ratings')) li")
    check("rating: agreed 8.5 saved", "8.5" in rows.nth(0).inner_text())
    check("rating: both people inherit it", all("agreed" in rows.nth(i).inner_text() for i in (1, 2)))
    check("details: where to watch in CA, credited to JustWatch", page.locator("text=Stream Co").count() == 1 and page.locator("text=Availability data from JustWatch").count() == 1)
    check("details: scores from OMDb and TMDB", page.locator("text=93%").count() == 1 and page.locator("text=TMDB score from TMDB.").count() == 1)
    check("details: status set to watched for both", page.locator("#status-A").input_value() == "watched" and page.locator("#status-B").input_value() == "watched")
    page.screenshot(path=str(SHOTS / "title.png"), full_page=True)

    # ---- 5. Alex rates separately, then goes back to the agreed rating
    rows.nth(2).locator("button:has-text('Rate')").click()
    page.click("fieldset:has-text(\"Alex's rating\") button[aria-label='9']"); page.click("button:has-text('Save')")
    page.wait_for_timeout(300)
    value = rows.nth(2).locator(".value").inner_text()
    check("rating: personal rating overrides", rows.nth(2).inner_text().startswith("Alex") and value.strip() == "9", value)
    rows.nth(2).locator("text=Use agreed").click(); page.wait_for_timeout(300)
    check("rating: 'Use agreed' restores inheritance", "agreed" in rows.nth(2).inner_text())

    # ---- 6. Notes, would-rewatch, second watch is a rewatch
    page.click("text=Add a note"); page.fill("textarea", "Watched on the train. Great score."); page.click("text=Save note"); page.wait_for_timeout(300)
    page.check("section:has(h2:has-text('Status')) li:has-text('Sam') input[type=checkbox]"); page.wait_for_timeout(200)
    page.click("text=Mark watched"); page.click("form.watched label.chip:has-text('Sam')"); page.click("form.watched button[type=submit]"); page.wait_for_timeout(500)
    history = page.locator("ul.history li")
    check("history: second watch recorded as a rewatch for Sam", history.count() == 2 and "rewatch" in history.nth(0).inner_text() and "Sam" in history.nth(0).inner_text())

    # ---- 7. A series onto Alex's watchlist; shows on For you
    page.click("nav >> text=Library"); page.click("a:has-text('Add')")
    page.fill("input[type=search]", "Sample"); page.click("button.result:has-text('Sample Show')")
    page.click("text=Want to watch"); page.click("label.chip:has-text('Alex')"); page.click("text=Add to watchlist")
    page.wait_for_selector("h1:has-text('Sample Show')")
    check("watchlist: only Alex", page.locator("#status-B").input_value() == "watchlist" and page.locator("#status-A").input_value() == "")
    page.click("nav >> text=For you"); page.click("button.mode:has-text('Alex')")
    page.wait_for_selector("ol.slate >> text=Sample Show", timeout=20000)
    check("for you: Alex's watchlist title among Alex's picks", page.locator("ol.slate >> text=Sample Show").count() == 1)

    # ---- 8. Library filters and note search
    page.click("nav >> text=Library"); page.wait_for_selector(".grid li")
    check("library: two titles", page.locator(".grid li").count() == 2)
    page.fill("input[type=search]", "train"); page.wait_for_timeout(200)
    check("library: search finds note text", page.locator(".grid li").count() == 1 and "Sample Film" in page.inner_text(".grid"))
    page.fill("input[type=search]", ""); page.click("button:has-text('Filters')"); page.select_option("#library-filters select >> nth=1", "watchlist"); page.wait_for_timeout(200)
    check("library: status filter", page.locator(".grid li").count() == 1 and "Sample Show" in page.inner_text(".grid"))
    check("library: active filter count shown", page.locator("button:has-text('Filters (1)')").count() == 1)
    page.click("text=Clear filters"); page.click("button:has-text('Filters')")
    page.screenshot(path=str(SHOTS / "library.png"), full_page=True)

    # ---- 9. Offline: everything still opens; add by name
    ctx.set_offline(True); page.reload(); page.wait_for_selector(".grid li", timeout=20000)
    check("offline: library opens with no network", page.locator(".grid li").count() == 2)
    page.click(".grid li:has-text('Sample Film')"); page.wait_for_selector("text=Stream Co")
    check("offline: title page shows cached details", page.locator("text=93%").count() == 1)
    page.click("nav >> text=Library"); page.click("a:has-text('Add')")
    check("offline: search replaced by add-by-name", page.locator("text=Searching needs a network connection").count() == 1)
    page.fill("form.manual input >> nth=0", "Sample Flim"); page.fill("form.manual input >> nth=1", "2004"); page.click("form.manual button[type=submit]")
    page.wait_for_selector("text=Not matched to a TMDB entry yet")
    page.click("nav >> text=Library"); page.wait_for_selector(".grid li")
    check("offline: stub listed under 'Not matched yet'", page.locator("section:has-text('Not matched yet') >> text=Sample Flim").count() == 1)

    # ---- 10. Back online: find it; merges into the existing title
    ctx.set_offline(False); page.reload(); page.wait_for_selector(".grid li", timeout=20000)
    page.click("section:has-text('Not matched yet') >> text=Find it")
    page.wait_for_selector("button.result:has-text('Sample Film')"); page.click("button.result:has-text('Sample Film')")
    page.wait_for_selector("h1:has-text('Sample Film')")
    page.click("nav >> text=Library"); page.wait_for_timeout(300)
    check("find it: duplicate merged, no stub left", page.locator(".grid li").count() == 2 and page.locator("text=Not matched yet").count() == 0)

    # ---- 11. Backup without keys, remove a title, restore
    page.click("nav >> text=Settings"); page.click("text=Make a backup"); page.wait_for_selector("text=Save the file")
    with page.expect_download() as info: page.click("text=Save the file")
    backup = Path(tempfile.mkdtemp()) / "backup.sqlite"; info.value.save_as(backup)
    raw = backup.read_bytes()
    check("backup: is a SQLite file", raw[:16] == b"SQLite format 3\x00", f"{len(raw)} bytes")
    check("backup: contains no API keys", b"sample-tmdb-key" not in raw and b"sample-omdb-key" not in raw)
    check("backup: contains the household data", b"Sample Film" in raw and b"Watched on the train" in raw)
    page.click("nav >> text=Library"); page.click(".grid li:has-text('Sample Show')")
    page.click("text=Remove from library"); page.click("text=Tap again to remove it"); page.wait_for_selector("h1:has-text('Library')")
    check("remove: title gone after two taps", page.locator(".grid li").count() == 1)
    page.click("nav >> text=Settings"); page.set_input_files("input[type=file]", str(backup))
    page.click("button:has-text('Restore')"); page.click("text=Tap again: this replaces everything"); page.wait_for_selector("text=Restored 2 titles")
    check("restore: keys kept", page.input_value("input[type=password] >> nth=0") == "sample-tmdb-key")
    check("restore: names restored", page.input_value("text=First person >> xpath=.. >> input") == "Sam")
    page.click("nav >> text=Library"); page.wait_for_timeout(300)
    check("restore: removed title is back", page.locator(".grid li").count() == 2)
    page.click("nav >> text=Settings"); page.click("text=Device check"); page.wait_for_selector(".launch")
    check("restore: launch count kept", int(re.sub(r"\D", "", page.inner_text(".launch"))) >= launches_after)
    check("no page errors so far", not errors, "; ".join(errors[:3]))
    page.click("nav >> text=Settings"); page.screenshot(path=str(SHOTS / "settings.png"), full_page=True)
    ctx.close()

    # ---- 12. Six months later, offline: TMDB data deleted, household data kept
    ctx, page, errors = launch()
    ctx.set_offline(True)
    page.clock.set_fixed_time(time.time() + 200 * 86400)
    page.goto(URL + "#/library"); page.wait_for_selector(".grid li", timeout=20000); page.wait_for_timeout(1500)
    page.click(".grid li:has-text('Sample Film')")
    page.wait_for_selector("h1:has-text('Sample Film')")
    check("purge: TMDB details gone after six months", page.locator("text=Stream Co").count() == 0 and page.locator("text=Not matched to a TMDB entry yet").count() == 1)
    check("purge: household rating and notes kept", "8.5" in page.locator("section:has(h2:has-text('Ratings')) li").nth(0).inner_text() and page.locator("text=Watched on the train").count() == 1)
    ctx.close()

    # ---- 13. Back online: relinked from the IMDb id
    ctx, page, errors = launch()
    page.clock.set_fixed_time(time.time() + 200 * 86400)
    finds = calls["find"]
    page.goto(URL + "#/library"); page.wait_for_selector(".grid li", timeout=20000)
    page.click(".grid li:has-text('Sample Film')"); page.wait_for_selector("text=Stream Co", timeout=15000)
    check("relink: found again from the IMDb id", calls["find"] > finds)
    check("no page errors after the purge", not errors, "; ".join(errors[:3]))
    ctx.close()
    os.killpg(server.pid, signal.SIGTERM)

print(f"\n{sum(ok for _, ok in results)} of {len(results)} checks passed")
sys.exit(0 if all(ok for _, ok in results) else 1)
