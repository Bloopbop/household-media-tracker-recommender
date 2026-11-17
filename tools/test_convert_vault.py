"""Tests for convert_vault.py, on a small made-up vault.

Run with: python3 -m unittest discover -s tools
"""

import csv
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import convert_vault  # noqa: E402

NOTES = {
    "wiki/watched/movies/sample-film.md": """---
title: "Sample Film"
type: watched
medium: film
year: 2004
creators: ["Dee Rector"]
genre: [drama, romance]
tags: [memory]
rating: 8.5   # agreed
watched_date: 2026-05-11
created: 2026-05-11
---

## Summary
Made up.

## What works
The score, like in [[sample-show]].

## What doesn't
*Not recorded.*

## Notes
Rewatched it last year. Season 1 had nothing to do with it.
""",
    "wiki/watched/tv-shows/sample-show.md": """---
title: "Sample Show (US)"
type: watched
medium: television
year: "2011–"
creators:
  - Cree Ator
  - "Second, Person"
genre: [comedy]
rating: 7
watched_date: 2026-05-12
---

## Notes
Seasons 1-3: 8.5; season 4: 6.5
""",
    "wiki/watched/movies/two-films.md": """---
title: "Two Films"
medium: film
year: "2014–2015"
creators: []
genre: []
rating: 6
---
""",
    "wiki/recommendations/maybe-later.md": """---
title: "Maybe Later"
type: recommendation
medium: film
year: 1999
genre: [crime]
status: pending
match_score: high
scouted_date: 2026-05-11
---
""",
    "wiki/dismissed.md": """# Dismissed

- Not For Us (2020) — dismissed 2026-05-11
""",
}


class ConvertVaultTest(unittest.TestCase):
    def setUp(self):
        self.vault = tempfile.mkdtemp()
        self.out = tempfile.mkdtemp()
        for relative, text in NOTES.items():
            path = os.path.join(self.vault, relative)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text)
        os.makedirs(os.path.join(self.vault, "wiki", "watched", "anime"), exist_ok=True)
        self.status = convert_vault.main([self.vault, "--out", self.out])
        with open(os.path.join(self.out, "vault-import.json"), encoding="utf-8") as handle:
            self.bundle = json.load(handle)

    def test_bundle_header_and_counts(self):
        self.assertEqual(self.status, 0)
        self.assertEqual(self.bundle["format"], "hmtr-vault-import")
        self.assertEqual(self.bundle["version"], 1)
        self.assertEqual(len(self.bundle["library"]), 3)
        self.assertEqual(len(self.bundle["candidates"]), 1)
        self.assertEqual(len(self.bundle["not_interested"]), 1)

    def test_library_rows_are_typed(self):
        film = next(row for row in self.bundle["library"] if row["title"] == "Sample Film")
        self.assertEqual(film["year"], 2004)
        self.assertEqual(film["rating"], 8.5)
        self.assertEqual(film["kind"], "movie")
        self.assertEqual(film["creators"], ["Dee Rector"])
        self.assertEqual(film["genres"], ["drama", "romance"])
        self.assertIsNone(film["watched_on"])
        self.assertEqual(film["added_to_vault"], "2026-05-11")
        self.assertEqual(film["what_works"], "The score, like in Sample Show (US).")
        self.assertEqual(film["what_doesnt"], "")
        self.assertEqual(film["participants"], "both")

    def test_series_title_hint_and_ongoing(self):
        show = next(row for row in self.bundle["library"] if row["kind"] == "series")
        self.assertEqual(show["search_title"], "Sample Show")
        self.assertEqual(show["title_hint"], "US")
        self.assertTrue(show["ongoing"])
        self.assertIsNone(show["year_end"])
        # A comma inside a name is kept; only the converter's own separator splits.
        self.assertEqual(show["creators"], ["Cree Ator", "Second, Person"])

    def test_candidates_and_dismissed(self):
        candidate = self.bundle["candidates"][0]
        self.assertEqual(candidate["destination"], "candidate_pool")
        self.assertEqual(candidate["year"], 1999)
        dismissed = self.bundle["not_interested"][0]
        self.assertEqual(dismissed, {"title": "Not For Us", "year": 2020, "dismissed_on": "2026-05-11",
                                     "source_file": "wiki/dismissed.md"})

    def test_review_items(self):
        issues = {(item["title"], item["issue"]) for item in self.bundle["needs_review"]}
        self.assertIn(("Two Films", "film with a range of years"), issues)
        self.assertIn(("Sample Show (US)", "title has a qualifier in brackets"), issues)
        self.assertIn(("Sample Show (US)", "per-season scores in the notes"), issues)
        self.assertIn(("Sample Film", "mentions a rewatch"), issues)

    def test_csv_and_bundle_agree(self):
        with open(os.path.join(self.out, "library.csv"), encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual([row["title"] for row in rows], [row["title"] for row in self.bundle["library"]])


if __name__ == "__main__":
    unittest.main()
