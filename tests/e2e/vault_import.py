"""Browser test of the vault import and shared-ratings review, with hand-written sample responses."""
import base64, json, os, re, signal, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
from harness import CHROME, ROOT, build, dist

SHOTS = Path(sys.argv[1]); SHOTS.mkdir(exist_ok=True)
BUNDLE = str(Path(__file__).with_name("fixtures") / "vault-import.json")  # made-up vault, converted
PORT = 4199; URL = f"http://localhost:{PORT}/"
CORS = {"access-control-allow-origin": "*"}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

MOVIES = {101: ("Sample Film", "2004-03-19", "Dee Rector"), 301: ("Twin Title", "2010-05-01", "Ann Maker"),
          302: ("Twin Title", "2010-09-01", "Bob Other"), 401: ("Obscure Things Part II", "1992-01-01", "Someone"),
          601: ("Not For Us", "2020-02-02", "X"), 701: ("Maybe Later", "1999-01-01", "Y")}
SERIES = {202: ("Sample Show", "2011-01-09", "Cree Ator", ["US"]), 203: ("Sample Show", "2011-02-01", "Other Writer", ["GB"]),
          501: ("Docu Series", "2020-04-01", "Doc Maker", ["US"])}
def m(i): t, d, _ = MOVIES[i]; return {"id": i, "title": t, "original_title": t, "release_date": d, "poster_path": f"/p{i}.png", "popularity": 5}
def s(i): t, d, _, c = SERIES[i]; return {"id": i, "name": t, "original_name": t, "first_air_date": d, "poster_path": f"/p{i}.png", "origin_country": c, "popularity": 5}
MOVIE_SEARCH = {"Sample Film": [101], "Twin Title": [301, 302], "Obscure Thing": [401], "Maybe Later": [701], "Sample": [101], "Not For Us": [601]}
TV_SEARCH = {"Sample Show": [202, 203], "Sample": [202]}
MULTI = {"Docu Series": [("tv", 501)], "Not For Us": [("movie", 601)], "Obscure Thing": [("movie", 401)], "Sample": [("movie", 101), ("tv", 202)]}

def details_movie(i):
    t, d, director = MOVIES[i]
    return {**m(i), "runtime": 100, "genres": [{"name": "Drama"}], "vote_average": 7, "vote_count": 10, "original_language": "en",
            "production_countries": [], "status": "Released", "credits": {"cast": [], "crew": [{"name": director, "job": "Director"}]},
            "keywords": {"keywords": []}, "external_ids": {"imdb_id": f"tt{i:07d}"}, "recommendations": {"results": []},
            "similar": {"results": []}, "watch/providers": {"results": {}}}
def details_tv(i):
    t, d, creator, c = SERIES[i]
    return {**s(i), "last_air_date": "2022-01-01", "episode_run_time": [30], "genres": [{"name": "Comedy"}], "vote_average": 7,
            "vote_count": 10, "original_language": "en", "created_by": [{"name": creator}], "status": "Ended", "number_of_seasons": 2,
            "credits": {"cast": []}, "keywords": {"results": []}, "external_ids": {"imdb_id": f"tt{i:07d}"},
            "recommendations": {"results": []}, "similar": {"results": []}, "watch/providers": {"results": {}}}

def mock(ctx):
    def j(route, body, status=200):
        route.fulfill(status=status, headers={**CORS, "content-type": "application/json"}, body=json.dumps(body))
    def tmdb(route):
        u = urlparse(route.request.url); q = parse_qs(u.query).get("query", [""])[0]; path = u.path
        if "/discover/" in path or "/trending/" in path: return j(route, {"results": []})  # phase 2 gathers candidates
        if path.endswith("/search/movie"): return j(route, {"results": [m(i) for i in MOVIE_SEARCH.get(q, [])]})
        if path.endswith("/search/tv"): return j(route, {"results": [s(i) for i in TV_SEARCH.get(q, [])]})
        if path.endswith("/search/multi"):
            return j(route, {"results": [{**(m(i) if k == "movie" else s(i)), "media_type": k} for k, i in MULTI.get(q, [])]})
        hit = re.search(r"/(movie|tv)/(\d+)$", path)
        if hit:
            i = int(hit.group(2))
            if hit.group(1) == "movie" and i in MOVIES: return j(route, details_movie(i))
            if hit.group(1) == "tv" and i in SERIES: return j(route, details_tv(i))
        hit = re.search(r"/find/tt(\d+)$", path)
        if hit:
            i = int(hit.group(1))
            return j(route, {"movie_results": [{"id": i}] if i in MOVIES else [], "tv_results": [{"id": i}] if i in SERIES else []})
        return j(route, {"status_message": "not found"}, 404)
    ctx.route("https://api.themoviedb.org/**", tmdb)
    ctx.route("https://www.omdbapi.com/**", lambda r: j(r, {"Response": "True", "imdbRating": "7.0", "imdbVotes": "1,000", "Metascore": "60", "Ratings": []}))
    ctx.route("https://image.tmdb.org/**", lambda r: r.fulfill(status=200, headers={**CORS, "content-type": "image/png"}, body=PNG))

results = []
def check(name, ok, detail=""):
    results.append(bool(ok)); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + str(detail)) if detail else ''}")

server = subprocess.Popen(["npx", "vite", "preview", "--outDir", dist(), "--port", str(PORT), "--strictPort"],
                          cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
time.sleep(3)
profile = tempfile.mkdtemp()
with sync_playwright() as p:
    def launch():
        ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
                                                   viewport={"width": 390, "height": 844}, device_scale_factor=2)
        mock(ctx)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.on("console", lambda msg: errors.append(msg.text[:200]) if msg.type == "error" and "ERR_INTERNET_DISCONNECTED" not in msg.text and "probe" not in msg.text else None)
        return ctx, page, errors
    def library_names(page):
        page.wait_for_timeout(400)
        return [t.strip() for t in page.locator(".grid .name").all_inner_texts()]

    ctx, page, errors = launch()
    page.goto(URL + "#/library"); page.wait_for_selector("h1:has-text('Library')")
    check("empty library offers the vault import", page.locator("a:has-text('Import the vault')").count() == 1)
    page.click("nav >> text=Settings")
    page.fill("text=First person >> xpath=.. >> input", "Sam"); page.fill("text=Second person >> xpath=.. >> input", "Alex"); page.click("text=Save names")
    page.fill("input[type=password] >> nth=0", "sample-tmdb-key"); page.fill("input[type=password] >> nth=1", "sample-omdb-key")
    page.fill("label.short input", "CA"); page.click("form:has-text('TMDB key') button[type=submit]"); page.wait_for_selector("text=Saved.")

    # A title already in the app, with its own agreed rating of 9
    page.click("nav >> text=Library"); page.click("a:has-text('Add')"); page.fill("input[type=search]", "Sample")
    page.click("button.result:has-text('Sample Film')"); page.click("text=Watched it")
    page.click("fieldset:has-text('Your agreed rating') button[aria-label='9']"); page.click("form.watched button[type=submit]")
    page.wait_for_selector("h1:has-text('Sample Film')")

    # Import
    page.click("nav >> text=Settings"); page.click("text=Import from the vault"); page.wait_for_selector("h1:has-text('Import from the vault')")
    page.set_input_files("input[type=file]", BUNDLE)
    try: page.wait_for_selector("text=6 watched titles, 1 not interested, 2", timeout=5000)  # the file is read asynchronously
    except Exception: pass
    check("file summary", page.locator("text=6 watched titles, 1 not interested, 2").count() == 1, page.inner_text("main") if page.locator("main").count() else "")
    page.click("button:has-text('Import')")
    page.wait_for_selector("text=imported", timeout=30000); page.wait_for_function("() => !document.querySelector('progress')", timeout=30000)
    page.wait_for_timeout(800)
    counts = page.inner_text(".counts")
    check("matched 6 automatically, 3 need a person", "6 imported" in counts and "3 need you" in counts, counts.replace("\n", " "))
    page.screenshot(path=str(SHOTS / "import-review.png"), full_page=True)
    review_titles = [t.strip() for t in page.locator(".vault-title").all_inner_texts()]
    check("left for a person: no exact title, nothing found, unclear recommendation",
          sorted(review_titles) == ["Lost Film (1980)", "Obscure Thing (1990)", "Unclear Rec (2001)"], review_titles)
    check("nothing-found row offers a search again", page.locator("li:has-text('Lost Film') >> text=TMDB found nothing").count() == 1)
    check("checklist from the converter", page.locator("text=To check: 3 left").count() == 1)

    # Resolve some
    page.click("li:has-text('Unclear Rec') >> text=Skip it"); page.wait_for_timeout(500)
    page.click("li:has-text('Lost Film') >> text=Keep it unmatched"); page.wait_for_timeout(500)
    check("recommendation skipped and lost film kept unmatched", page.locator(".vault-title").all_inner_texts() == ["Obscure Thing (1990)"])

    # Library results
    page.click("nav >> text=Library"); page.wait_for_selector(".grid li")
    names = library_names(page)
    check("library shows the imported watched titles", sorted(names) == sorted(["Sample Film", "Sample Show (US)", "Twin Title", "Docu Series", "Lost Film"]), names)
    check("not-interested title hidden from the default view", "Not For Us" not in names)
    check("lost film listed under 'Not matched yet'", page.locator("section:has-text('Not matched yet') >> text=Lost Film").count() == 1)
    check("import banner points to what is left", page.locator(".notice:has-text('Vault import') >> text=1 to choose").count() == 1)
    page.click(".grid li:has-text('Sample Film')"); page.wait_for_selector("h1:has-text('Sample Film')")
    rows = page.locator("section:has(h2:has-text('Ratings')) li")
    check("existing agreed rating kept (9, not the vault's 8.5)", rows.nth(0).locator(".value").inner_text().strip() == "9")
    check("vault note added", page.locator("text=Rewatched it with friends").count() == 1)
    check("vault viewing added without a date", page.locator("ul.history li:has-text('Date not recorded') >> text=imported").count() == 1)
    page.click("nav >> text=Library"); page.click(".grid li:has-text('Sample Show')"); page.wait_for_selector("h1")
    check("country qualifier chose the US version", page.locator("text=Created by Cree Ator").count() == 1)
    page.click("nav >> text=Library"); page.click(".grid li:has-text('Twin Title')"); page.wait_for_selector("h1")
    check("tie settled by the director", page.locator("text=Directed by Ann Maker").count() == 1)
    page.click("nav >> text=Library"); page.click(".grid li:has-text('Docu Series')"); page.wait_for_selector("h1")
    check("documentary filed as a film matched as a series", page.locator("p.muted:has-text('Series')").count() >= 1)
    page.click("nav >> text=Library"); page.click("button:has-text('Filters')"); page.select_option("#library-filters select >> nth=1", "not_interested")
    check("not-interested title under its own status", library_names(page) == ["Not For Us"])
    page.click("text=Clear filters")
    check("no page errors so far", not errors, errors[:3])
    ctx.close()

    # Six months on, offline: suggested matches are deleted with the rest of TMDB's data
    ctx, page, errors = launch()
    ctx.set_offline(True); page.clock.set_fixed_time(time.time() + 200 * 86400)
    page.goto(URL + "#/import"); page.wait_for_selector("h1:has-text('Import from the vault')"); page.wait_for_timeout(2500)
    page.reload(); page.wait_for_selector("h1:has-text('Import from the vault')"); page.wait_for_timeout(1000)
    check("purge: cached suggestions deleted at six months", page.locator("li:has-text('Obscure Thing') >> text=Search again").count() == 1)
    ctx.close()

    # Back to today, online: search again, choose, finish, re-import
    ctx, page, errors = launch()
    page.goto(URL + "#/import"); page.wait_for_selector("li:has-text('Obscure Thing')")
    page.click("li:has-text('Obscure Thing') >> text=Search again"); page.wait_for_selector("button.option:has-text('Obscure Things Part II')")
    page.click("button.option:has-text('Obscure Things Part II')"); page.wait_for_timeout(600)
    check("chosen match imported", page.locator(".vault-title").count() == 0 and "8 imported" in page.inner_text(".counts"), page.inner_text(".counts"))
    for _ in range(3):
        page.locator(".checks input[type=checkbox]").first.check(); page.wait_for_timeout(300)
    check("checklist cleared", page.locator("text=To check: 0 left").count() == 1)
    page.click("text=Finish import"); page.wait_for_selector("text=Import finished.")
    page.set_input_files("input[type=file]", BUNDLE); page.click("button:has-text('Import')")
    page.wait_for_selector("text=Everything in this file is already in the app.")
    check("importing the same file again adds nothing", True)

    # Shared ratings review
    page.goto(URL + "#/agree?person=A"); page.wait_for_selector("text=reviewed by Sam")
    check("six shared ratings to review", "0 of 6 reviewed by Sam" in page.inner_text(".progress"), page.inner_text(".progress"))
    first = page.locator(".list li").nth(0); second = page.locator(".list li").nth(1); third = page.locator(".list li").nth(2)
    order = [first.locator(".name").inner_text(), second.locator(".name").inner_text(), third.locator(".name").inner_text()]
    first.locator("button:has-text('Agree')").click(); page.wait_for_timeout(300)
    second.locator("button[aria-label='Half a point lower']").click(); page.wait_for_timeout(300)
    third.locator("text=Other").click(); third.locator("button[aria-label='3']").click(); third.locator("button:has-text('Save')").click(); page.wait_for_timeout(300)
    check("agree, nudge and pick", "Agreed: 9" in first.inner_text() and "Sam: 8.5" in second.inner_text() and "Sam: 3" in third.inner_text(), order)
    third.locator("text=Undo").click(); page.wait_for_timeout(300)
    check("undo returns the title to the list", "Shared rating" in third.inner_text())
    check("progress counts personal ratings", "2 of 6 reviewed by Sam" in page.inner_text(".progress"))
    page.screenshot(path=str(SHOTS / "agree.png"), full_page=True)
    page.click(".who >> text=Alex"); page.wait_for_selector("text=reviewed by Alex")
    check("Alex starts at none", "0 of 6 reviewed by Alex" in page.inner_text(".progress"))
    page.click("nav >> text=Library"); page.wait_for_selector(".grid li")
    check("library banner counts what is left", page.locator("text=Sam, 4 left").count() == 1 and page.locator("text=Alex, 6 left").count() == 1)
    page.click(".grid li:has-text('Sample Film')"); page.wait_for_selector("h1:has-text('Sample Film')")
    sam = page.locator("section:has(h2:has-text('Ratings')) li").nth(1)
    check("nudged rating is Sam's own", sam.locator(".value").inner_text().strip() == "8.5", sam.inner_text())
    check("no page errors", not errors, errors[:3])
    ctx.close()
os.killpg(server.pid, signal.SIGTERM)
print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)
