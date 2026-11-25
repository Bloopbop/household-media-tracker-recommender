"""Browser test of phase 2, part 1, with hand-written sample data only.

A household of 60 rated films is restored from a backup made by the app and
filled in with sqlite3: 20 science-fiction films by one director, liked (9 to
10), 20 dramas, neutral (8 to 8.5), and 20 comedies, disliked (6 to 7.5),
plus a watchlist title and two vault recommendations. TMDB's scores favour the comedies, so only
the recommender's content and collaborative parts can rank correctly.

Covers: the library's records fetched again in the new shape; gathering the
pool (recommendations, discover, trending, services, vault seeds); details
for candidates; slates for Sam, Alex and Together with reasons, exploratory
places and a rewatch, their ranked places mixing the recommender's picks with
review scores' picks; the pick page with Why this?; streaming services;
the recommendation check and its copied text; opening offline; backups
without slates; reactions (Not tonight with undo, Want to watch, Not
interested, Seen it with a rating, from the list and from the pick page),
which leave the list, refill it, persist and reach the library; Picks
compared; backups keeping the signals; clearing cached data.
"""
import json, os, re, signal, sqlite3, subprocess, sys, tempfile, time, uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright
from harness import CHROME, ROOT, build, dist

SHOTS = Path(sys.argv[1]); SHOTS.mkdir(exist_ok=True)
DIST = dist()
PORT = 4199; URL = f"http://localhost:{PORT}/"
CORS = {"access-control-allow-origin": "*"}
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c63f8cfc0f01f0005000201b5e0f2b70000000049454e44ae426082")

def movie(tmdb_id, genre, director, keywords, vote, recs=(), sims=(), offers=None, year=2005):
    return {"id": tmdb_id, "title": f"{genre[1]} {tmdb_id}", "original_title": f"{genre[1]} {tmdb_id}", "release_date": f"{year}-05-01",
            "overview": "A made-up film used only for testing.", "poster_path": f"/{tmdb_id}.png", "runtime": 104,
            "genres": [{"id": genre[0], "name": genre[1]}], "vote_average": vote, "vote_count": 600, "popularity": 10,
            "original_language": "en", "production_countries": [{"iso_3166_1": "US"}], "status": "Released",
            "credits": {"cast": [{"id": 9000 + tmdb_id, "name": f"Actor {tmdb_id}", "order": 0}],
                        "crew": [{"id": director[0], "name": director[1], "job": "Director"}]},
            "keywords": {"keywords": [{"id": k, "name": n} for k, n in keywords]},
            "external_ids": {"imdb_id": f"tt{tmdb_id:07d}"},
            "recommendations": {"results": [{"id": r, "media_type": "movie"} for r in recs]},
            "similar": {"results": [{"id": s} for s in sims]},
            "watch/providers": {"results": {"CA": offers} if offers else {}}}

SCIFI, COMEDY, DRAMA = (878, "Science Fiction"), (35, "Comedy"), (18, "Drama")
DEE, PAT, LEE, KIM = (1, "Dee Rector"), (2, "Pat Funny"), (3, "Lee Newcomer"), (4, "Kim Drama")
STREAM = {"flatrate": [{"provider_id": 8, "provider_name": "Stream Co", "logo_path": "/s.png"}]}
OTHER = {"flatrate": [{"provider_id": 9, "provider_name": "Other Co", "logo_path": "/o.png"}]}
RENT = {"rent": [{"provider_id": 3, "provider_name": "Rent Co", "logo_path": "/r.png"}]}

MOVIES = {}
for i in range(20):  # library: sci-fi liked, dramas neutral, comedies disliked; each recommends its neighbours
    MOVIES[100 + i] = movie(100 + i, SCIFI, DEE, [(10, "space"), (11, "starships"), (1000 + i, f"theme {i}")], 6.6,
                            recs=[100 + (i + k) % 20 for k in (1, 2, 3)] + list(range(400, 410)), sims=range(410, 415), offers=STREAM)
    MOVIES[300 + i] = movie(300 + i, DRAMA, KIM, [(30, "family"), (3000 + i, f"loss {i}")], 7.2,
                            recs=[300 + (i + k) % 20 for k in (1, 2)] + list(range(600, 605)), offers=OTHER)
    MOVIES[200 + i] = movie(200 + i, COMEDY, PAT, [(20, "pratfall"), (21, "office"), (2000 + i, f"gag {i}")], 7.8,
                            recs=[200 + (i + k) % 20 for k in (1, 2)] + list(range(500, 510)), offers=RENT)
MYSTERY = (9648, "Mystery")
for i in range(30):  # pool
    if 25 <= i < 30:  # new mysteries by the liked director, with few votes: exploratory
        m = movie(400 + i, MYSTERY, DEE, [(10, "space"), (11, "starships"), (4000 + i, f"idea {i}")], 6.4, offers=STREAM, year=2025)
        m["genres"].append({"id": 878, "name": "Science Fiction"})
        MOVIES[400 + i] = m
    else:
        MOVIES[400 + i] = movie(400 + i, SCIFI, DEE if i < 20 else LEE, [(10, "space"), (4000 + i, f"idea {i}")], 6.5, offers=STREAM, year=2015)
    MOVIES[500 + i] = movie(500 + i, COMEDY, PAT, [(20, "pratfall"), (5000 + i, f"joke {i}")], 8.0, offers=RENT, year=2015)
for i in range(20):
    MOVIES[600 + i] = movie(600 + i, DRAMA, KIM, [(30, "family"), (6000 + i, f"tear {i}")], 7.2, offers=OTHER, year=2015)
ACTION, ACE = (28, "Action"), (5, "Ace Explosion")
for i in range(30):  # popular titles, chosen without the household's taste
    MOVIES[800 + i] = movie(800 + i, ACTION, ACE, [(80, "chase"), (8000 + i, f"stunt {i}")], 7.5, offers=OTHER, year=2024)
MOVIES[650] = movie(650, SCIFI, DEE, [(10, "space"), (11, "starships")], 7.0, offers=STREAM, year=2016)   # on both watchlists
MOVIES[700] = movie(700, DRAMA, KIM, [(30, "family")], 7.4, offers=OTHER, year=2014)                        # vault recommendation
MOVIES[701] = movie(701, SCIFI, LEE, [(10, "space")], 7.1, offers=STREAM, year=2014)                       # vault recommendation

calls = {"discover": [], "omdb": [], "details": 0, "providers": 0, "trending": 0}

def discover(params):
    if "with_watch_providers" in params: return list(range(600, 620))
    if params.get("with_genres") == "878": return list(range(420, 430))
    if params.get("with_keywords") == "10": return list(range(415, 430))
    if params.get("with_people") == "1": return list(range(400, 420))
    if params.get("sort_by") == "popularity.desc" and params.get("page") == "1": return list(range(800, 830))
    return []

TRENDING = list(range(500, 520)) + list(range(600, 605))

def mock(ctx):
    def j(route, body, status=200):
        route.fulfill(status=status, headers={**CORS, "content-type": "application/json"}, body=json.dumps(body))
    def tmdb(route):
        url = urlparse(route.request.url); path = url.path.replace("/3", "", 1); params = {k: v[0] for k, v in parse_qs(url.query).items()}
        if path.startswith("/discover/"):
            calls["discover"].append((path, params))
            ids = discover(params) if path.endswith("/movie") else []
            return j(route, {"results": [{"id": i, "title": MOVIES[i]["title"], "release_date": MOVIES[i]["release_date"], "poster_path": MOVIES[i]["poster_path"]} for i in ids]})
        if path == "/trending/all/week":
            calls["trending"] += 1
            return j(route, {"results": [{"id": i, "media_type": "movie", "title": MOVIES[i]["title"]} for i in TRENDING] + [{"id": 1, "media_type": "person", "name": "Someone"}]})
        if path.startswith("/watch/providers/"):
            calls["providers"] += 1
            return j(route, {"results": [{"provider_id": 8, "provider_name": "Stream Co", "logo_path": "/s.png", "display_priorities": {"CA": 1}},
                                         {"provider_id": 9, "provider_name": "Other Co", "logo_path": "/o.png", "display_priorities": {"CA": 2}}]})
        m = re.match(r"^/movie/(\d+)$", path)
        if m and int(m.group(1)) in MOVIES:
            calls["details"] += 1
            return j(route, MOVIES[int(m.group(1))])
        return j(route, {"status_message": "not found"}, 404)
    def omdb(route):
        imdb = parse_qs(urlparse(route.request.url).query).get("i", [""])[0]; calls["omdb"].append(imdb)
        n = int(imdb[2:]) if imdb[2:].isdigit() else 0
        votes = "300" if 425 <= n < 430 else "50,000"   # a few new titles with few votes stay cold
        j(route, {"Response": "True", "imdbRating": "7.0", "imdbVotes": votes, "Metascore": "70",
                  "Ratings": [{"Source": "Internet Movie Database", "Value": "7.0/10"}, {"Source": "Rotten Tomatoes", "Value": "80%"}]})
    ctx.route("https://api.themoviedb.org/**", tmdb)
    ctx.route("https://www.omdbapi.com/**", omdb)
    ctx.route("https://api.tvmaze.com/**", lambda r: j(r, {}))
    ctx.route("https://image.tmdb.org/**", lambda r: r.fulfill(status=200, headers={**CORS, "content-type": "image/png"}, body=PNG))

def household(path):
    """Fills an empty backup made by the app with the sample household."""
    db = sqlite3.connect(path); now = int(time.time() * 1000)
    def title(tmdb_id, score=None, rewatch_a=False, status="watched"):
        tid = str(uuid.uuid4())
        db.execute("INSERT INTO title (id, kind, name, year, tmdb_id, source, created_at, updated_at) VALUES (?, 'movie', ?, 2005, ?, 'vault', ?, ?)",
                   (tid, MOVIES[tmdb_id]["title"], tmdb_id, now, now))
        if score is not None:
            db.execute("INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES ('US', ?, ?, ?, 'vault')", (tid, score, now))
        for person in ("A", "B"):
            db.execute("INSERT INTO title_state (profile_id, title_id, status, would_rewatch, updated_at) VALUES (?, ?, ?, ?, ?)",
                       (person, tid, status, 1 if (rewatch_a and person == "A") else 0, now))
        if status == "watched":
            db.execute("INSERT INTO watch_event (id, title_id, participants, completion, is_rewatch, source, created_at) VALUES (?, ?, 3, 1, 0, 'vault', ?)",
                       (str(uuid.uuid4()), tid, now))
    for i in range(20):
        title(100 + i, (9, 9.5, 10)[i % 3], rewatch_a=i < 3)
        title(300 + i, (8, 8.5)[i % 2])
        title(200 + i, (6, 7, 7.5)[i % 3])
    title(650, status="watchlist")
    for seed in (700, 701):
        db.execute("INSERT INTO pool_seed (id, kind, name, year, tmdb_id, tmdb_checked_at, source, added_at) VALUES (?, 'movie', ?, 2014, ?, ?, 'vault', ?)",
                   (str(uuid.uuid4()), MOVIES[seed]["title"], seed, now, now))
    db.commit(); db.close()

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok))); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}", flush=True)

def wait_idle(page, timeout=240):
    """Waits for the background work to finish (no status line in Settings)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate("document.querySelector('[aria-live=polite]') === null"): return True
        page.wait_for_timeout(1000)
    return False

server = subprocess.Popen(["npx", "vite", "preview", "--outDir", DIST, "--port", str(PORT), "--strictPort"],
                          cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
time.sleep(3)
profile = tempfile.mkdtemp()
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True,
                                                   viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
        mock(ctx)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:300]))

        # ---- 1. Opens on For you; keys and names; an empty backup to fill
        page.goto(URL); page.wait_for_selector("h1:has-text('For you')")
        check("launch: opens on For you", page.url.endswith("/") or "recommend" in page.url, page.url)
        page.click("nav >> text=Settings")
        page.fill("text=First person >> xpath=.. >> input", "Sam"); page.fill("text=Second person >> xpath=.. >> input", "Alex")
        page.click("text=Save names"); page.wait_for_selector("text=Saved.")
        page.fill("input[type=password] >> nth=0", "sample-tmdb-key"); page.fill("input[type=password] >> nth=1", "sample-omdb-key")
        page.fill("label.short input", "CA")
        page.click("section:has(#services) form button[type=submit]"); page.wait_for_selector("section:has(#services) >> text=Saved")
        page.click("text=Make a backup")
        with page.expect_download() as info: page.click("button:has-text('Save the file')")
        backup = Path(tempfile.mkdtemp()) / "household.sqlite"; info.value.save_as(backup)
        household(backup)

        # ---- 2. Restore the sample household; fetch its records; gather candidates
        page.set_input_files("section:has(#backup) input[type=file]", str(backup))
        page.click("button:has-text('Restore')"); page.click("text=Tap again")
        page.wait_for_selector("text=Restored 61 titles.")
        page.click("text=Refresh now"); page.wait_for_selector("text=/titles? updated/", timeout=120000)
        check("refresh: library records fetched in the new shape", calls["details"] >= 61, f"{calls['details']} detail calls")
        page.click("text=Gather candidates now")
        page.wait_for_timeout(1500)
        check("pool: background work finishes", wait_idle(page))
        status = page.inner_text("section:has(#recommendations)")
        gathered = re.search(r"([\d,]+) candidates gathered, ([\d,]+) with details", status)
        check("pool: candidates gathered with details", gathered and int(gathered.group(1).replace(",", "")) >= 80 and gathered.group(1) == gathered.group(2), gathered.group(0) if gathered else status[:200])
        check("pool: popular titles searched without taste", any(q[1].get("sort_by") == "popularity.desc" and "with_watch_providers" not in q[1] for q in calls["discover"]))
        check("pool: discover searched the liked genre, keyword and director", any(q[1].get("with_genres") == "878" for q in calls["discover"])
              and any(q[1].get("with_keywords") == "10" for q in calls["discover"]) and any(q[1].get("with_people") == "1" for q in calls["discover"]))
        check("pool: no discover search for the disliked genre", not any(q[1].get("with_genres") == "35" for q in calls["discover"]))
        check("pool: trending fetched", calls["trending"] >= 1)
        check("omdb: review scores for top candidates", any(c.startswith("tt00004") for c in calls["omdb"]), f"{len(calls['omdb'])} OMDb calls")

        # ---- 3. For you
        page.click("nav >> text=For you"); page.wait_for_selector("ol.slate li")
        page.click("button.mode:has-text('Together')"); page.wait_for_timeout(500)
        picks = page.locator("ol.slate li")
        names = [picks.nth(i).locator(".name").inner_text() for i in range(picks.count())]
        reasons = [picks.nth(i).locator(".reason").inner_text() for i in range(picks.count())]
        check("together: 20 picks", len(names) == 20, str(len(names)))
        # The ranked places alternate between the recommender (science fiction first) and review scores alone (comedies first).
        check("together: science fiction in the first two places", any(n.startswith("Science Fiction 4") for n in names[:2]), ", ".join(names[:2]))
        check("together: the liked taste holds its share of the top places", sum(n.startswith("Science Fiction 4") for n in names[:9]) >= 3
              and sum(n.startswith("Comedy") for n in names[:9]) <= 5, ", ".join(names[:9]))
        check("together: no watched title shown", not any(re.match(r"(Science Fiction|Comedy|Drama) (1|2|3)\d\d$", n) for n in names))
        check("together: reasons name a liked title or the liked director", sum(bool(re.search(r"Science Fiction 1\d\d|Dee Rector", r)) for r in reasons) >= 10, reasons[0])
        check("together: every reason within 140 characters", all(len(r) <= 140 for r in reasons))
        tags = [picks.nth(i).locator(".tag").all_inner_texts() for i in range(picks.count())]
        exploratory = [i + 1 for i, t in enumerate(tags) if "Exploratory" in t]
        check("together: exploratory picks at 5, 10, 15, 20", exploratory == [5, 10, 15, 20], str(exploratory))
        check("together: exploratory picks are the new mysteries", all(names[i - 1].startswith("Mystery 42") for i in exploratory), ", ".join(names[i - 1] for i in exploratory))
        first_sf = next(i for i, n in enumerate(names) if n.startswith("Science Fiction 4"))
        check("together: availability shown", "On Stream Co" in picks.nth(first_sf).inner_text(), picks.nth(first_sf).locator(".meta").inner_text())
        check("together: four reactions under each pick", picks.nth(0).locator(".reactions button").count() == 4)
        page.screenshot(path=str(SHOTS / "p2-for-you-together.png"), full_page=True)
        page.click("button.mode:has-text('Sam')"); page.wait_for_timeout(500)
        sam = page.locator("ol.slate li")
        sam_rewatch = [sam.nth(i).inner_text() for i in range(sam.count()) if "Rewatch" in sam.nth(i).inner_text()]
        check("sam: at most two rewatches, from Sam's would-rewatch flags", 1 <= len(sam_rewatch) <= 2 and all("You've seen this and would watch it again." in t for t in sam_rewatch), str(len(sam_rewatch)))
        page.click("button.mode:has-text('Alex')"); page.wait_for_timeout(500)
        alex = page.inner_text("ol.slate")
        check("alex: no rewatch (Alex flagged none)", "Rewatch" not in alex)
        page.click("button.mode:has-text('Together')"); page.wait_for_timeout(300)

        # ---- 4. Pick page and Why this?
        page.locator("ol.slate li").nth(first_sf).locator("a.pick").click(); page.wait_for_selector("h2#why")
        check("pick: Why this? shows the parts", page.locator(".parts li").count() == 4 and page.locator(".bar").count() >= 2)
        check("pick: partner part off", page.locator("text=Off until you each have 30 ratings of your own.").count() == 1)
        evidence = page.inner_text(".evidence")
        check("pick: evidence names a liked title and TMDB's list", "Most like" in evidence and "TMDB recommends it alongside" in evidence, evidence[:160])
        check("pick: where to watch with credit", page.locator("text=Availability data from JustWatch").count() == 1 and page.locator(".providers >> text=Stream Co").count() == 1)
        check("pick: TMDB credit", page.locator("text=Title details from TMDB").count() == 1)
        page.screenshot(path=str(SHOTS / "p2-pick.png"), full_page=True)
        page.click("text=← Back"); page.wait_for_selector("ol.slate li")

        # ---- 5. Streaming services
        page.click("nav >> text=Settings"); page.click("text=Load the services for CA")
        page.wait_for_selector("label.service:has-text('Stream Co')")
        page.check("label.service:has-text('Other Co') input"); page.click("text=Save services")
        page.wait_for_selector("text=/Saved. Picks on these services/")
        page.wait_for_timeout(1500); wait_idle(page)
        check("services: discover by service in the region", any("with_watch_providers" in q[1] and q[1].get("watch_region") == "CA" for q in calls["discover"]))
        page.click("nav >> text=For you"); page.wait_for_selector("ol.slate li")
        metas = page.locator("ol.slate .meta").all_inner_texts()
        check("services: Stream Co titles now marked as not yours", any("which you don't have" in m for m in metas), metas[0])

        # ---- 6. Offline: picks open from storage, quickly
        ctx.set_offline(True); page.goto(URL); page.wait_for_selector("ol.slate li", timeout=20000)
        check("offline: picks shown from storage", page.locator("ol.slate li").count() == 20)

        # ---- 7. Recommendation check (works offline too)
        page.click("nav >> text=Settings"); page.click("text=Recommendation check")
        page.click("button:has-text('Run the check')"); page.wait_for_selector("pre.results", timeout=60000)
        text = page.inner_text("pre.results")
        lifts = [float(x.replace("−", "-")) for x in re.findall(r"vs neutral \(\d+\): .*?lift ([+−]\d\.\d\d)", text)]
        check("check: results for Sam, Alex and Together", text.count("rated 60") == 3, text.splitlines()[3][:160] if len(text.splitlines()) > 3 else text)
        check("check: recommender beats scores alone", len(lifts) == 3 and all(l >= 0.05 for l in lifts), str(lifts))
        check("check: gate passes, picks quick to show", "lift 0.05+ in every mode pass" in text and "picks under 1.5 s pass" in text, text.splitlines()[-1])
        check("check: diagnostics reported", "among rated:" in text and "vs pool (" in text and "means fav/other/neutral/pool" in text)
        check("check: numbers only, no titles", "Science Fiction" not in text and "Comedy" not in text and "Dee Rector" not in text)
        print(text, flush=True)
        page.screenshot(path=str(SHOTS / "p2-check.png"), full_page=True)
        ctx.set_offline(False); page.goto(URL); page.wait_for_selector("ol.slate li", timeout=20000)

        # ---- 8. Backups leave slates out; clearing cached data clears them
        page.click("nav >> text=Settings"); page.click("text=Make a backup")
        with page.expect_download() as info: page.click("button:has-text('Save the file')")
        saved = Path(tempfile.mkdtemp()) / "b.sqlite"; info.value.save_as(saved)
        db = sqlite3.connect(saved)
        check("backup: no slates, household kept", db.execute("SELECT COUNT(*) FROM slate").fetchone()[0] == 0 and db.execute("SELECT COUNT(*) FROM rating").fetchone()[0] == 60)
        check("backup: device-only last mode left out", db.execute("SELECT COUNT(*) FROM settings WHERE key = 'rec_mode'").fetchone()[0] == 0)
        db.close()
        # ---- 9. Reactions: one tap, the pick leaves and the list refills
        page.click("nav >> text=For you"); page.wait_for_selector("ol.slate li")
        page.click("button.mode:has-text('Together')"); page.wait_for_timeout(600)
        def names_now():
            items = page.locator("ol.slate li")
            return [items.nth(i).locator(".name").inner_text() for i in range(items.count())]
        def row(name):
            return page.locator("ol.slate li", has=page.locator(f".name:text-is('{name}')"))
        before = names_now()
        row(before[0]).locator("button:has-text('Not tonight')").click()
        page.wait_for_selector(".done:has-text('Hidden for 14 days')"); page.wait_for_timeout(400)
        after = names_now()
        check("react: Not tonight takes the pick off and the list refills", before[0] not in after and len(after) == 20, f"{before[0]}; {len(after)} picks")
        page.click(".done button:has-text('Undo')"); page.wait_for_timeout(800)
        check("react: undo puts it back where it was", names_now()[0] == before[0], names_now()[0])
        wanted = next(n for n in names_now() if n.startswith("Science Fiction 4"))
        row(wanted).locator("button:has-text('Want to watch')").click()
        page.wait_for_selector(".done:has-text('Added to both lists')"); page.wait_for_timeout(400)
        check("react: Want to watch leaves the list", wanted not in names_now() and len(names_now()) == 20)
        declined_us = names_now()[3]
        row(declined_us).locator("button:has-text('Not interested')").click()
        page.wait_for_selector(".done:has-text('for the two of you')"); page.wait_for_timeout(400)

        page.click("button.mode:has-text('Sam')"); page.wait_for_timeout(600)
        def plain():  # picks that are not rewatches, which have their own reactions
            items = page.locator("ol.slate li")
            return [items.nth(i).locator(".name").inner_text() for i in range(items.count()) if "Rewatch" not in items.nth(i).inner_text()]
        declined = plain()[1]
        row(declined).locator("button:has-text('Not interested')").click()
        page.wait_for_selector(".done:has-text('suggested again')"); page.wait_for_timeout(400)
        seen = plain()[2]
        row(seen).locator("button:has-text('Seen it')").click()
        row(seen).locator("fieldset button[aria-label='9']").click()
        row(seen).locator("button:has-text('Save')").click()
        page.wait_for_selector(".done:has-text('Saved as seen')"); page.wait_for_timeout(400)
        check("react: Not interested and Seen it leave Sam's list", declined not in names_now() and seen not in names_now() and len(names_now()) == 20)
        # From the pick page
        from_page = names_now()[0]
        page.locator("ol.slate li").nth(0).locator("a.pick").click(); page.wait_for_selector("h2#why")
        page.click(".react-panel button:has-text('Not tonight')"); page.wait_for_selector("text=Hidden for 14 days")
        page.click("text=Back to For you"); page.wait_for_selector("ol.slate li"); page.wait_for_timeout(600)
        check("react: from the pick page too", from_page not in names_now(), from_page)
        page.screenshot(path=str(SHOTS / "p2-reactions.png"), full_page=True)

        # They stay off after reopening, and reach the library
        page.goto(URL); page.wait_for_selector("ol.slate li"); page.click("button.mode:has-text('Sam')"); page.wait_for_timeout(600)
        check("react: still off after reopening", not {declined, seen, from_page} & set(names_now()))
        page.click("button.mode:has-text('Together')"); page.wait_for_timeout(600)
        check("react: Together's Not interested stays off Together", declined_us not in names_now() and wanted not in names_now())
        page.click("nav >> text=Library"); page.wait_for_selector(".grid li")
        page.click(f".grid li:has-text('{seen}')"); page.wait_for_selector(f"h1:has-text('{seen}')")
        ratings = page.inner_text("section:has(h2:has-text('Ratings'))")
        check("library: Seen it saved Sam's rating and a watch", "9" in ratings and page.locator("#status-A").input_value() == "watched", ratings[:120])
        page.click("nav >> text=Library"); page.click(f".grid li:has-text('{wanted}')"); page.wait_for_selector(f"h1:has-text('{wanted}')")
        check("library: Want to watch in Together put it on both lists", page.locator("#status-A").input_value() == "watchlist" and page.locator("#status-B").input_value() == "watchlist")
        page.click("nav >> text=Library"); page.wait_for_selector(".grid li")
        check("library: titles only marked not interested stay out of view", page.locator(f".grid li:has-text('{declined}')").count() == 0)
        page.click("button:has-text('Filters')"); page.select_option("#library-filters select >> nth=1", "not_interested"); page.wait_for_timeout(300)
        page.click(f".grid li:has-text('{declined}')"); page.wait_for_selector(f"h1:has-text('{declined}')")
        check("library: Sam's Not interested saved for Sam only", page.locator("#status-A").input_value() == "not_interested" and page.locator("#status-B").input_value() == "")

        # Picks compared
        page.click("nav >> text=Settings"); page.click("text=Picks compared"); page.wait_for_selector("pre.results")
        compared = page.inner_text("pre.results")
        totals = re.search(r"All: recommender shown (\d+).*?\| reviews shown (\d+)", compared)
        check("compare: both rankings shown and counted", totals and int(totals.group(1)) >= 5 and int(totals.group(2)) >= 5, compared.splitlines()[2][:200])
        check("compare: reactions credited", re.search(r"want 1", compared) is not None and "not interested" in compared)
        check("compare: too early to judge", "verdict early" in compared and page.locator("text=/Too early: day 0 of 14/").count() == 1)
        check("compare: numbers only", "Science Fiction" not in compared and "Comedy" not in compared)
        print(compared, flush=True)
        page.screenshot(path=str(SHOTS / "p2-compare.png"), full_page=True)

        # Backups keep the signals (household data) and still leave slates out
        page.click("nav >> text=Settings"); page.click("text=Make a backup")
        with page.expect_download() as info: page.click("button:has-text('Save the file')")
        saved = Path(tempfile.mkdtemp()) / "c.sqlite"; info.value.save_as(saved)
        db = sqlite3.connect(saved)
        kinds = dict(db.execute("SELECT type, COUNT(*) FROM signal GROUP BY type").fetchall())
        arms = {row[0] for row in db.execute("SELECT DISTINCT arm FROM signal")}
        check("backup: signals kept with their arm", kinds.get("impression", 0) >= 20 and kinds.get("not_interested") == 2 and kinds.get("seen") == 1
              and kinds.get("watchlist") == 1 and kinds.get("not_tonight") == 1 and {"model", "reviews"} <= arms, str(kinds))
        check("backup: still no slates", db.execute("SELECT COUNT(*) FROM slate").fetchone()[0] == 0)
        db.close()

        page.click("text=Clear cached data"); page.click("text=Tap again to clear"); page.wait_for_selector("text=Cached data cleared")
        page.click("nav >> text=For you"); page.wait_for_timeout(1500)
        check("clear: slates gone with the cache", page.locator("ol.slate li").count() == 0 or page.locator("text=Picked from").count() == 0)

        check("no page errors", not errors, "; ".join(errors[:3]))
        ctx.close()
finally:
    os.killpg(server.pid, signal.SIGTERM)

passed = sum(ok for _, ok in results)
print(f"\n{passed} of {len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
