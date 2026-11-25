# Browser tests

End-to-end tests of the built app in a real browser, using Playwright for
Python. They stand in for TMDB, OMDb and TVmaze with hand-written responses,
so no live service is called and no key is needed. Each test builds the app,
serves the build with `vite preview` on port 4199, and prints one PASS or FAIL
line per check. It exits non-zero if any check fails.

```bash
pip install playwright        # once; add --break-system-packages where pip asks
python3 tests/e2e/library.py /tmp/shots        # screenshots go in the folder named
python3 tests/e2e/recommender.py /tmp/shots /path/to/dist   # optional: reuse a build
```

Run them from the repository root, one at a time (they share the port). They
use Google Chrome at `CHROME_PATH`, or `/usr/bin/google-chrome`, or else
Playwright's own Chromium (`python3 -m playwright install chromium`).

| Test | Checks | What it covers |
| --- | --- | --- |
| `library.py` | 38 | Upgrade from the last phase 0 build (built from git), search, ratings, status, watches, the library's filters, offline use, backup and restore, the six-month purge |
| `vault_import.py` | 31 | Importing the converted vault (`fixtures/vault-import.json`, from a made-up vault), the review list, the shared-ratings review |
| `share.py` | 24 | Sharing and saving backups where browsers refuse a database file |
| `change_match.py` | 14 | Changing a title's match, and review scores following the new match |
| `recommender.py` | 55 | For you: the candidate pool, picks, reasons and Why this?, services, reactions and undo, the recommendation check, Picks compared |
| `combine.py` | 15 | Two browser profiles as the two phones, combining each other's backups |

Every check counts. When a change alters something a test looks for, update
the test in the same pull request and say so.
