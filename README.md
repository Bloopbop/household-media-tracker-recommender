# Household Media Tracker and Recommender

A private, local-first app for two people to track what they watch and decide
what to watch next. All household data stays on the device.

**Status: phase 1.** The library works: add titles by search or by name, rate
them (an agreed rating plus personal ones), track status, notes and watches,
import the household's Obsidian vault, review the shared ratings person by
person, and make or restore backups. Recommendations arrive in phase 2.

## Importing the Obsidian vault

1. Convert the vault on a computer (Python 3.8 or later, no packages needed):

   ```bash
   python3 tools/convert_vault.py /path/to/obsidian_tvmovies --out ./import
   ```

   This writes four CSV files to read, plus `vault-import.json`, which holds
   the same rows in one file. The converter never writes inside the vault.
2. Move `vault-import.json` to the phone, then in the app go to
   Settings → Import from the vault and choose it.
3. The app matches each title to TMDB, accepting only unambiguous matches.
   Anything else waits in a list for you to choose, and the converter's
   checklist appears below it.

Importing fills gaps and never overwrites: ratings, statuses and notes already
in the app are kept. Each title remembers the vault note it came from, so
importing an updated vault later adds only what is new.

The phase 0 device check is still in the app under Settings → Device check; see
[docs/phase-0-checklist.md](docs/phase-0-checklist.md).

## How it is built

- Svelte and TypeScript, built with Vite into a static site.
- Installable as a home-screen app, with a service worker for offline use.
- SQLite compiled to WebAssembly, stored on the browser's private file system,
  running in a worker.
- Deployed to GitHub Pages by the workflow in `.github/workflows/pages.yml`.

## Keys and privacy

The app talks to TMDB, OMDb and TVmaze directly from the browser. API keys are
typed into the app and saved in the device's own database. They are never
committed to this repository and never sent anywhere except to the service they
belong to. A Content-Security-Policy in the built page limits network access to
those services. Backups leave out the keys and this device's own records.

## Storage

- `household.db`: the household's records. The source of truth, and the only
  file in a backup.
- `cache.db`: data fetched from TMDB and OMDb. Disposable; rebuilt by refreshing.
  TMDB data is deleted once it reaches six months without a refresh, as TMDB's
  API terms require. Posters are cached by the service worker for 170 days.

Tests use hand-written sample data shaped like the services' documented
responses; no live service data is kept in this repository.

## Development

Requires Node 22.

```bash
npm install
npm run dev      # local development server
npm run check    # type checks
npm test         # unit tests
python3 -m unittest discover -s tools   # converter tests
npm run build    # production build in dist/
npm run preview  # serve the production build locally
```

## Data credits

This application uses TMDB and the TMDB APIs but is not endorsed, certified, or
otherwise approved by TMDB.

Streaming availability data is provided by JustWatch. Episode data comes from
[TVmaze](https://www.tvmaze.com), licensed CC BY-SA 4.0. Review scores come from
the OMDb API.
