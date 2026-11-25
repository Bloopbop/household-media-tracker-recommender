# CLAUDE.md — Household Media Tracker and Recommender

A local-first web app for a two-person household: track what they watch, and
pick what to watch next. Svelte 5 and TypeScript, built with Vite, installed
from GitHub Pages as a home-screen app on two phones: a Galaxy S24 (Chrome)
and an iPhone 14 (Safari). All household data lives on the phones. This
repository and the public site hold none of it.

## How we work

- The owner tests on the phones and merges. Work on a branch and open one pull
  request per change; never push to `main`. Merging redeploys the site
  (`.github/workflows/pages.yml`), and the installed apps update themselves.
- Before opening a pull request, run `npm run check`, `npm test`, and the
  browser tests the change touches (all of them when shared code changes). Say
  in the pull request what ran and how many checks passed.
- The product spec, its decisions and the build-status table are in a Claude
  doc, linked from the project instructions (ask for the link if you don't
  have it). After a merge, update the build status there.
- Results from the phones (Device check, Recommendation check, Picks compared)
  arrive as pasted text. Record them in the spec, not in this repository.
- `docs/status.md` lists what is waiting on someone. Keep it current.

## Rules that don't bend

- Keys (TMDB, OMDb) are typed into the app and stay on the device: never in
  commits, logs, backups or test output.
- No household data here or on the site: no titles, ratings, names or exports
  from the phones or the household's vault.
- Test against hand-written sample data shaped like the documented responses.
  Never paste or save live TMDB or OMDb responses.
- TMDB terms: non-commercial use, TMDB data deleted after six months without a
  refresh, and the attribution on the About page.
- The household's Obsidian vault is a separate, private repository, and
  read-only. Its own CLAUDE.md describes the vault, not this app.
  `tools/convert_vault.py` is the only code that reads it.
- The app shares the `bloopbop.github.io` address with the Screening Room
  companion (`Bloopbop/screening-room`), so the browser treats both as one site.
  Keep storage names (OPFS files, IndexedDB databases, caches) unique to this
  app, never clear site-wide storage, and keep the service worker scoped to
  this app's path.
- Keep personal names, email addresses and phone numbers out of code, tests and
  commits. Tests use made-up people (Alex and Sam).

## Commands

```bash
npm install
npm run dev                             # development server
npm run check                           # svelte-check and TypeScript
npm test                                # unit tests (vitest)
npm run build                           # production build in dist/
python3 -m unittest discover -s tools   # vault converter tests
python3 tests/e2e/<test>.py /tmp/shots  # browser tests: see tests/e2e/README.md
```

## Where things are

- `src/lib/db.worker.ts`, `schema.ts`, `repo.ts`: SQLite (WebAssembly, on the
  browser's private file system) in a worker. `household.db` holds the
  records and is the only file in a backup; `cache.db` holds fetched data and
  is rebuilt by refreshing. Schema changes are new entries at the end of the
  ordered migration lists in `schema.ts`; never edit an applied one.
- `src/lib/backup.ts`, `merge.ts`: backup, restore, and Combine with the other
  phone. Newer ratings, statuses and title details win; watches, notes and
  signals are added; nothing is deleted.
- `src/lib/gateway/`: the TMDB and OMDb clients, rate limits, poster caching,
  and the candidate pool.
- `src/lib/rec/`: the recommender. Features and profile, scoring, ranked lists
  that mix the recommender with review scores alone (`interleave.ts`),
  reactions and their effects (`reactions.ts`, `feedback.ts`), the offline
  check (`backtest.ts`) and Picks compared (`compare.ts`).
- `src/views/`: the screens. `src/lib/routes.ts`: the hash routes.
- `tools/convert_vault.py`: the one-time vault converter (Python, no
  dependencies).
- `docs/phase-0-checklist.md`: the phone set-up and device checks.
