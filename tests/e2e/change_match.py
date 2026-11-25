"""Browser test of "Change the match" with hand-written sample data.

A series is added as the wrong version (British, 2004), rated, noted and
logged; then its match is changed to the right version (American, 2011).
The rating, note and watch history must stay, the details and review scores
must switch to the new entry, and the stored IMDb id must follow it.
"""
import base64, json, os, re, signal, sqlite3, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright
from harness import CHROME, ROOT, build, dist

SHOTS = Path(sys.argv[1]); SHOTS.mkdir(exist_ok=True)
PORT = 4199; URL = f"http://localhost:{PORT}/"
CORS = {"access-control-allow-origin": "*"}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

def show(tmdb_id, first, last, country, creator, imdb, seasons):
    return {"id": tmdb_id, "name": "Sample Show", "original_name": "Sample Show", "first_air_date": first, "last_air_date": last,
            "overview": "A made-up series.", "poster_path": f"/{tmdb_id}.png", "episode_run_time": [50], "genres": [{"name": "Drama"}],
            "vote_average": 8.0, "vote_count": 50, "original_language": "en", "origin_country": [country],
            "created_by": [{"name": creator}], "status": "Ended", "number_of_seasons": seasons, "number_of_episodes": seasons * 10,
            "credits": {"cast": []}, "keywords": {"results": []}, "external_ids": {"imdb_id": imdb},
            "recommendations": {"results": []}, "similar": {"results": []}, "watch/providers": {"results": {}}}

DETAILS = {203: show(203, "2004-01-13", "2013-05-28", "GB", "Pat Original", "tt0000203", 11),
           202: show(202, "2011-01-09", "2021-04-11", "US", "Dev Eloper", "tt0000202", 11)}
SEARCH = {"results": [
    {"media_type": "tv", "id": 203, "name": "Sample Show", "first_air_date": "2004-01-13", "origin_country": ["GB"], "poster_path": "/203.png", "popularity": 9},
    {"media_type": "tv", "id": 202, "name": "Sample Show", "first_air_date": "2011-01-09", "origin_country": ["US"], "poster_path": "/202.png", "popularity": 8}]}
OMDB = {"tt0000203": "7.1", "tt0000202": "8.6"}
omdb_calls = []

def mock(ctx):
    def j(route, body, status=200):
        route.fulfill(status=status, headers={**CORS, "content-type": "application/json"}, body=json.dumps(body))
    def tmdb(route):
        url = route.request.url
        if "/search/" in url: return j(route, SEARCH)
        for tmdb_id, body in DETAILS.items():
            if f"/tv/{tmdb_id}" in url: return j(route, body)
        return j(route, {"status_message": "not found"}, 404)
    def omdb(route):
        imdb = parse_qs(urlparse(route.request.url).query).get("i", [""])[0]
        omdb_calls.append(imdb)
        score = OMDB.get(imdb)
        if not score: return j(route, {"Response": "False", "Error": "Incorrect IMDb ID."})
        j(route, {"Response": "True", "imdbRating": score, "imdbVotes": "1,234", "Metascore": "N/A",
                  "Ratings": [{"Source": "Internet Movie Database", "Value": f"{score}/10"}]})
    ctx.route("https://api.themoviedb.org/**", tmdb)
    ctx.route("https://www.omdbapi.com/**", omdb)
    ctx.route("https://api.tvmaze.com/**", lambda r: j(r, {}))
    ctx.route("https://image.tmdb.org/**", lambda r: r.fulfill(status=200, headers={**CORS, "content-type": "image/png"}, body=PNG))

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok))); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")

server = subprocess.Popen(["npx", "vite", "preview", "--outDir", dist(), "--port", str(PORT), "--strictPort"],
                          cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
time.sleep(3)
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), executable_path=CHROME, headless=True,
                                                   viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
        mock(ctx)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.goto(URL); page.wait_for_selector("nav.tabs")

        # Keys
        page.click("nav >> text=Settings")
        page.fill("input[type=password] >> nth=0", "sample-tmdb-key"); page.fill("input[type=password] >> nth=1", "sample-omdb-key")
        page.click("section:has(#services) form button[type=submit]"); page.wait_for_selector("section:has(#services) >> text=Saved")

        # Add the wrong version, with a rating, a note and a watch
        page.click("nav >> text=Library"); page.click("a:has-text('Add')")
        page.fill("input[type=search]", "Sample Show"); page.wait_for_selector("button.result >> nth=1")
        lines = [page.locator("button.result").nth(i).inner_text() for i in range(2)]
        check("search: results show each version's country", "2004 · GB" in lines[0] and "2011 · US" in lines[1], " | ".join(l.replace("\n", " ") for l in lines))
        page.click("button.result:has-text('2004')"); page.click("text=Watched it")
        page.click("form.watched label:has-text('Not sure when')")
        page.click("fieldset:has-text('Your agreed rating') button[aria-label='8']")
        page.click("form.watched button[type=submit]")
        page.wait_for_selector("h1:has-text('Sample Show')"); page.wait_for_selector("text=Created by Pat Original")
        page.wait_for_selector("text=7.1", timeout=10000)
        check("before: the British version, with its IMDb score", page.locator(".facts >> text=2004").count() >= 1 and "tt0000203" in omdb_calls, str(omdb_calls))
        page.click("text=Add a note"); page.fill("textarea", "Season scores live here."); page.click("text=Save note")
        page.wait_for_selector("p.note-text:has-text('Season scores live here.')")
        check("before: the change-match link is offered", page.locator("text=Wrong version?").count() == 1)
        page.screenshot(path=str(SHOTS / "match-1-wrong.png"), full_page=True)

        # Change the match
        calls_before = len(omdb_calls)
        page.click("text=Change the match")
        page.wait_for_selector("h1:has-text('Find the right title')"); page.wait_for_selector("button.result >> nth=1")
        lines = [page.locator("button.result").nth(i).inner_text() for i in range(2)]
        check("link page: the current match is labelled", "current match" in lines[0] and "current match" not in lines[1], " | ".join(l.replace("\n", " ") for l in lines))
        page.screenshot(path=str(SHOTS / "match-2-choose.png"), full_page=True)
        page.click("button.result:has-text('2011')")
        page.wait_for_selector("text=Created by Dev Eloper", timeout=10000)
        page.wait_for_selector("text=8.6", timeout=10000)
        check("after: details are the American version", page.locator(".facts >> text=2011").count() >= 1 and page.locator("text=Pat Original").count() == 0)
        check("after: review scores fetched for the new IMDb id", omdb_calls[calls_before:] == ["tt0000202"], str(omdb_calls[calls_before:]))
        check("after: old score gone", page.locator("text=7.1").count() == 0)
        rows = page.locator("section:has(h2:has-text('Ratings')) li")
        check("after: agreed rating kept", "8" in rows.nth(0).inner_text(), rows.nth(0).inner_text().replace("\n", " "))
        check("after: note kept", page.locator("p.note-text:has-text('Season scores live here.')").count() == 1)
        check("after: watch history kept", page.locator("ul.history li").count() == 1)
        page.screenshot(path=str(SHOTS / "match-3-right.png"), full_page=True)

        # What is stored
        page.click("nav >> text=Library"); page.wait_for_selector(".grid li")
        check("library: still one title", page.locator(".grid li").count() == 1)
        page.click("nav >> text=Settings"); page.click("text=Make a backup")
        with page.expect_download() as info: page.click("button:has-text('Save the file')")
        saved = Path(tempfile.mkdtemp()) / "backup.sqlite"; info.value.save_as(saved)
        db = sqlite3.connect(saved)
        titles = db.execute("SELECT kind, tmdb_id, imdb_id, name, year FROM title").fetchall()
        check("stored: one title, linked to the new entry and its IMDb id", titles == [("series", 202, "tt0000202", "Sample Show", 2011)], str(titles))
        check("stored: rating, note and watch kept",
              db.execute("SELECT rater, score FROM rating").fetchall() == [("US", 8.0)]
              and db.execute("SELECT COUNT(*) FROM title_note").fetchone()[0] == 1
              and db.execute("SELECT COUNT(*) FROM watch_event").fetchone()[0] == 1)
        db.close()
        check("no page errors", not errors, "; ".join(errors))
        ctx.close()
finally:
    os.killpg(server.pid, signal.SIGTERM)

passed = sum(ok for _, ok in results)
print(f"\n{passed} of {len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
