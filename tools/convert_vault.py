#!/usr/bin/env python3
"""One-time converter: Obsidian film and TV vault -> import files for the
household media tracker.

Reads the vault and writes four CSV files for people to read, plus the same
rows in one file for the app to import. It never writes inside the vault and
makes no network requests; matching titles to TMDB happens later, in the app's
import step.

Usage:
    python3 convert_vault.py /path/to/vault --out ./import

Output files:
    library.csv         One row per watched title. Every row is a shared
                        viewing (participants = both) with the agreed rating
                        (rating_scope = shared). watched_on is left blank
                        because the vault's watched_date is the day the note
                        was added, not the day the title was watched; that
                        date is kept in added_to_vault for the record.
    candidates.csv      Pending recommendations, to seed the candidate pool.
                        A recommendation marked accepted goes to the watchlist.
    not_interested.csv  Dismissed titles.
    needs_review.csv    Things a person should check by hand after import.
    vault-import.json   All four, with typed values, in one file. This is the
                        file to move to the phone and import in the app.

Needs Python 3.8 or later. No third-party packages.
"""

import argparse
import csv
import json
import os
import re
from datetime import datetime, timezone
import sys
from collections import Counter

MOVIE_MEDIA = {"film", "documentary", "short"}
SERIES_MEDIA = {"television", "limited-series"}
WATCHED_FOLDERS = ("movies", "tv-shows", "anime")

FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)(.*)\Z", re.S
)
KEY_RE = re.compile(r"^([A-Za-z_][\w-]*):(.*)$")
BLOCK_ITEM_RE = re.compile(r"^\s*-\s+")
YEAR_RE = re.compile(r"^(\d{4})(?:\s*[–—-]\s*(\d{4}|present|ongoing)?)?$", re.I)
RANGE_MARK_RE = re.compile(r"[–—-]")
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]")
TRAILING_PAREN_RE = re.compile(r"^(.*\S)\s*\(([^()]+)\)$")
SEASON_SCORE_RE = re.compile(r"seasons?\s+\d[^\n]*?\b(?:10|[1-9])\.[05]\b", re.I)
REWATCH_RE = re.compile(r"\bre-?watch", re.I)
DISMISSED_RE = re.compile(
    r"^-\s+(.+?)\s*\((\d{4})\)\s*(?:[—–-]+\s*dismissed\s+(\d{4}-\d{2}-\d{2}))?\s*$"
)


# --------------------------------------------------------------------------
# Frontmatter: a small reader for the subset of YAML these notes use
# (plain values, quoted strings, inline lists, block lists, comments).
# --------------------------------------------------------------------------

def strip_comment(text):
    """Remove a trailing ' # comment' that sits outside quotes."""
    quote = None
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            if quote == '"' and ch == "\\":
                i += 1
            elif ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or text[i - 1] in " \t"):
            return text[:i].rstrip()
        i += 1
    return text.rstrip()


def scalar(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        return re.sub(r"\\(.)", r"\1", text[1:-1])
    if len(text) >= 2 and text[0] == text[-1] == "'":
        return text[1:-1].replace("''", "'")
    return text


def split_inline_list(text):
    items, current, quote = [], [], None
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            current.append(ch)
            if quote == '"' and ch == "\\" and i + 1 < len(text):
                current.append(text[i + 1])
                i += 1
            elif ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            current.append(ch)
        elif ch == ",":
            items.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    items.append("".join(current))
    return [scalar(item) for item in items if item.strip()]


def parse_frontmatter(raw):
    lines = raw.splitlines()
    data = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = KEY_RE.match(line)
        if not match:
            raise ValueError("cannot read frontmatter line: %r" % line)
        key = match.group(1)
        rest = strip_comment(match.group(2)).strip()
        if rest.startswith("["):
            while "]" not in rest and i < len(lines):
                rest += " " + strip_comment(lines[i]).strip()
                i += 1
            if not rest.endswith("]"):
                raise ValueError("unclosed list for %r" % key)
            data[key] = split_inline_list(rest[1:-1])
        elif rest == "":
            items = []
            while i < len(lines) and BLOCK_ITEM_RE.match(lines[i]):
                items.append(scalar(strip_comment(BLOCK_ITEM_RE.sub("", lines[i]))))
                i += 1
            data[key] = items if items else ""
        elif rest in ("|", ">", "|-", ">-"):
            raise ValueError("multi-line text for %r is not supported" % key)
        else:
            data[key] = scalar(rest)
    return data


def read_note(path):
    """Return (frontmatter dict, body text). Raises ValueError if unreadable."""
    with open(path, encoding="utf-8-sig") as handle:
        text = handle.read()
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise ValueError("no frontmatter block")
    return parse_frontmatter(match.group(1)), match.group(2)


# --------------------------------------------------------------------------
# Field helpers
# --------------------------------------------------------------------------

def as_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if value in (None, ""):
        return []
    return [str(value).strip()]


def parse_year(value):
    """Return (start, end, ongoing, is_range), or None if unreadable."""
    text = str(value).strip()
    match = YEAR_RE.match(text)
    if not match:
        return None
    is_range = bool(RANGE_MARK_RE.search(text))
    end = match.group(2)
    end_year = int(end) if end and end.isdigit() else ""
    ongoing = is_range and end_year == ""
    return int(match.group(1)), end_year, ongoing, is_range


def split_title(title):
    """'Shameless (US)' -> ('Shameless', 'US'). A trailing year is dropped."""
    match = TRAILING_PAREN_RE.match(title)
    if not match:
        return title, ""
    hint = match.group(2).strip()
    if re.fullmatch(r"\d{4}", hint):
        return match.group(1), ""
    return match.group(1), hint


def split_sections(body):
    """Map each level-2 heading (lower-cased) to the text beneath it."""
    out, current, buffer = {}, None, []
    for line in body.splitlines():
        match = re.match(r"^##(?!#)\s+(.+?)\s*$", line)
        if match:
            if current is not None:
                out[current] = "\n".join(buffer).strip()
            current, buffer = match.group(1).strip().lower(), []
        elif current is not None:
            buffer.append(line)
    if current is not None:
        out[current] = "\n".join(buffer).strip()
    return out


def clean_text(text, titles_by_slug):
    """Resolve [[wikilinks]] to plain titles; blank out 'Not recorded' stubs."""
    text = (text or "").strip()
    if re.match(r"^\*?\s*Not recorded", text):
        return ""

    def replace(match):
        if match.group(2):
            return match.group(2).strip()
        slug = match.group(1).strip()
        return titles_by_slug.get(slug.lower(), slug.replace("-", " "))

    return WIKILINK_RE.sub(replace, text)


def kind_from_medium(medium):
    if medium in MOVIE_MEDIA:
        return "movie"
    if medium in SERIES_MEDIA:
        return "series"
    return ""


def title_key(title, year):
    return (re.sub(r"\s+", " ", str(title)).strip().lower(), str(year))


# --------------------------------------------------------------------------
# Conversion
# --------------------------------------------------------------------------

def list_notes(folder):
    if not os.path.isdir(folder):
        return []
    return sorted(
        os.path.join(folder, name)
        for name in os.listdir(folder)
        if name.endswith(".md")
    )


def build_title_map(wiki):
    """slug (file name without .md) -> title, for resolving wikilinks."""
    titles = {}
    for folder, _dirs, files in os.walk(wiki):
        for name in files:
            if not name.endswith(".md"):
                continue
            try:
                front, _body = read_note(os.path.join(folder, name))
            except (ValueError, OSError):
                continue
            title = front.get("title")
            if isinstance(title, str) and title:
                titles[name[:-3].lower()] = title
    return titles


def common_fields(front, rel_path, review):
    """Fields shared by watched and recommendation notes."""
    title = str(front.get("title") or "").strip()
    if not title:
        review.append((rel_path, "", "missing title", "row skipped"))
        return None
    search_title, hint = split_title(title)
    if hint:
        review.append((rel_path, title, "title has a qualifier in brackets",
                       "search as '%s' and pick the '%s' entry" % (search_title, hint)))
    year = parse_year(front.get("year", ""))
    if year is None:
        review.append((rel_path, title, "year not readable",
                       "found '%s'; match this title by hand" % front.get("year", "")))
        year = ("", "", False, False)
    medium = str(front.get("medium") or "").strip().lower()
    return {
        "title": title,
        "search_title": search_title,
        "title_hint": hint,
        "year": year[0],
        "year_end": year[1],
        "ongoing": "yes" if year[2] else "",
        "is_range": year[3],
        "medium": medium,
        "creators": "; ".join(as_list(front.get("creators"))),
        "genres": "; ".join(as_list(front.get("genre"))),
        "source_file": rel_path,
    }


def convert_watched(vault, titles_by_slug, review):
    rows = []
    for folder_name in WATCHED_FOLDERS:
        folder = os.path.join(vault, "wiki", "watched", folder_name)
        for path in list_notes(folder):
            rel_path = os.path.relpath(path, vault)
            try:
                front, body = read_note(path)
            except (ValueError, OSError) as error:
                review.append((rel_path, "", "note could not be read", str(error)))
                continue
            row = common_fields(front, rel_path, review)
            if row is None:
                continue

            medium_kind = kind_from_medium(row["medium"])
            if folder_name == "movies":
                kind = "movie"
            elif folder_name == "tv-shows":
                kind = "series"
            else:
                kind = medium_kind
            if not kind:
                review.append((rel_path, row["title"], "type not known",
                               "medium is '%s'; set movie or series by hand" % row["medium"]))
            elif medium_kind and medium_kind != kind:
                review.append((rel_path, row["title"], "folder and medium disagree",
                               "folder says %s, medium is '%s'" % (kind, row["medium"])))
            if kind == "movie" and row["is_range"]:
                review.append((rel_path, row["title"], "film with a range of years",
                               "may cover more than one film; split into separate titles by hand"))

            rating = ""
            raw_rating = str(front.get("rating", "")).strip()
            try:
                value = float(raw_rating)
                if 1 <= value <= 10 and (value * 2) == int(value * 2):
                    rating = ("%g" % value)
                else:
                    raise ValueError
            except ValueError:
                review.append((rel_path, row["title"], "rating missing or not on the 1 to 10 half-point scale",
                               "found '%s'" % raw_rating))

            parts = split_sections(body)
            notes = clean_text(parts.get("notes"), titles_by_slug)
            what_works = clean_text(parts.get("what works"), titles_by_slug)
            what_doesnt = clean_text(parts.get("what doesn't"), titles_by_slug)

            season_lines = [
                re.sub(r"[*_`]", "", line).lstrip("- ").strip()
                for line in notes.splitlines()
                if SEASON_SCORE_RE.search(line)
            ]
            if season_lines:
                review.append((rel_path, row["title"], "per-season scores in the notes",
                               " | ".join(season_lines)))
            if REWATCH_RE.search("\n".join((notes, what_works, what_doesnt))):
                review.append((rel_path, row["title"], "mentions a rewatch",
                               "set the rewatch flag by hand if it applies"))

            row.update({
                "kind": kind,
                "anime": "yes" if folder_name == "anime" else "",
                "rating": rating,
                "rating_scope": "shared",
                "participants": "both",
                "status": "watched",
                "watched_on": "",
                "added_to_vault": str(front.get("watched_date") or front.get("created") or ""),
                "notes": notes,
                "what_works": what_works,
                "what_doesnt": what_doesnt,
            })
            rows.append(row)
    return rows


def convert_recommendations(vault, review):
    candidates, dismissed = [], []
    folder = os.path.join(vault, "wiki", "recommendations")
    for path in list_notes(folder):
        rel_path = os.path.relpath(path, vault)
        try:
            front, _body = read_note(path)
        except (ValueError, OSError) as error:
            review.append((rel_path, "", "note could not be read", str(error)))
            continue
        row = common_fields(front, rel_path, review)
        if row is None:
            continue
        kind = kind_from_medium(row["medium"])
        if kind == "movie" and row["is_range"]:
            review.append((rel_path, row["title"], "film or documentary with a range of years",
                           "probably a series; check the type after matching"))
        if not kind:
            review.append((rel_path, row["title"], "type not known",
                           "medium is '%s'" % row["medium"]))
        status = str(front.get("status") or "pending").strip().lower()
        if status == "dismissed":
            dismissed.append({"title": row["title"], "year": row["year"],
                              "dismissed_on": str(front.get("updated") or ""),
                              "source": rel_path})
            continue
        row.update({
            "kind": kind,
            "destination": "watchlist" if status == "accepted" else "candidate_pool",
            "vault_status": status,
            "match_score": str(front.get("match_score") or ""),
            "scouted_date": str(front.get("scouted_date") or ""),
        })
        candidates.append(row)
    return candidates, dismissed


def convert_dismissed(vault, review):
    rows = []
    path = os.path.join(vault, "wiki", "dismissed.md")
    if not os.path.isfile(path):
        return rows
    rel_path = os.path.relpath(path, vault)
    with open(path, encoding="utf-8-sig") as handle:
        for line in handle:
            line = line.rstrip()
            if not line.startswith("- "):
                continue
            match = DISMISSED_RE.match(line)
            if not match:
                review.append((rel_path, "", "dismissed line not readable", line))
                continue
            rows.append({"title": match.group(1), "year": match.group(2),
                         "dismissed_on": match.group(3) or "", "source": rel_path})
    return rows


def cross_check(library, candidates, dismissed, review):
    counts = Counter(title_key(r["title"], r["year"]) for r in library)
    for row in library:
        if counts[title_key(row["title"], row["year"])] > 1:
            review.append((row["source_file"], row["title"], "duplicate watched title",
                           "same title and year appears more than once"))
    watched = set(counts)
    for row in candidates:
        if title_key(row["title"], row["year"]) in watched:
            review.append((row["source_file"], row["title"], "recommendation already watched",
                           "remove it from candidates.csv"))
    for row in dismissed:
        if title_key(row["title"], row["year"]) in watched:
            review.append((row["source"], row["title"], "dismissed title is also in the library",
                           "decide which one is right"))


def write_csv(path, columns, rows):
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


BUNDLE_FORMAT = "hmtr-vault-import"
BUNDLE_VERSION = 1


def _list(value):
    return [part.strip() for part in str(value).split(";") if part.strip()]


def _int(value):
    text = str(value).strip()
    return int(text) if text.isdigit() else None


def _float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _shared(row):
    return {
        "title": row["title"],
        "search_title": row["search_title"],
        "title_hint": row["title_hint"],
        "year": _int(row["year"]),
        "year_end": _int(row["year_end"]),
        "ongoing": row["ongoing"] == "yes",
        "kind": row["kind"],
        "medium": row["medium"],
        "creators": _list(row["creators"]),
        "genres": _list(row["genres"]),
        "source_file": row["source_file"],
    }


def bundle_rows(library, candidates, dismissed, review):
    """The CSV rows with real types: numbers, lists, booleans and nulls."""
    return {
        "library": [
            dict(
                _shared(row),
                anime=row["anime"] == "yes",
                rating=_float(row["rating"]),
                rating_scope=row["rating_scope"],
                participants=row["participants"],
                status=row["status"],
                watched_on=row["watched_on"] or None,
                added_to_vault=row["added_to_vault"] or None,
                notes=row["notes"],
                what_works=row["what_works"],
                what_doesnt=row["what_doesnt"],
            )
            for row in library
        ],
        "candidates": [
            dict(
                _shared(row),
                destination=row["destination"],
                vault_status=row["vault_status"],
                match_score=row["match_score"],
                scouted_date=row["scouted_date"] or None,
            )
            for row in candidates
        ],
        "not_interested": [
            {"title": row["title"], "year": _int(row["year"]), "dismissed_on": row["dismissed_on"] or None,
             "source_file": row["source"]}
            for row in dismissed
        ],
        "needs_review": [dict(zip(REVIEW_COLUMNS, item)) for item in review],
    }


def write_bundle(path, vault, library, candidates, dismissed, review):
    bundle = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "vault": os.path.basename(vault),
    }
    bundle.update(bundle_rows(library, candidates, dismissed, review))
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(bundle, handle, ensure_ascii=False, indent=1)
        handle.write("\n")


LIBRARY_COLUMNS = [
    "title", "search_title", "title_hint", "year", "year_end", "ongoing",
    "kind", "medium", "anime", "creators", "genres",
    "rating", "rating_scope", "participants", "status",
    "watched_on", "added_to_vault",
    "notes", "what_works", "what_doesnt", "source_file",
]
CANDIDATE_COLUMNS = [
    "title", "search_title", "title_hint", "year", "year_end", "ongoing",
    "kind", "medium", "creators", "genres",
    "destination", "vault_status", "match_score", "scouted_date", "source_file",
]
DISMISSED_COLUMNS = ["title", "year", "dismissed_on", "source"]
REVIEW_COLUMNS = ["file", "title", "issue", "detail"]


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Convert the Obsidian film and TV vault into import files.")
    parser.add_argument("vault", help="path to the vault (the folder that contains wiki/)")
    parser.add_argument("--out", default="import", help="folder for the output files (default: ./import)")
    args = parser.parse_args(argv)

    vault = os.path.realpath(args.vault)
    out = os.path.realpath(args.out)
    wiki = os.path.join(vault, "wiki")
    if not os.path.isdir(os.path.join(wiki, "watched")):
        parser.error("no wiki/watched folder under %s" % vault)
    if out == vault or out.startswith(vault + os.sep):
        parser.error("choose an output folder outside the vault; this script never writes into it")

    review = []
    titles_by_slug = build_title_map(wiki)
    library = convert_watched(vault, titles_by_slug, review)
    candidates, dismissed_from_recs = convert_recommendations(vault, review)
    dismissed = convert_dismissed(vault, review) + dismissed_from_recs
    cross_check(library, candidates, dismissed, review)

    os.makedirs(out, exist_ok=True)
    write_csv(os.path.join(out, "library.csv"), LIBRARY_COLUMNS, library)
    write_csv(os.path.join(out, "candidates.csv"), CANDIDATE_COLUMNS, candidates)
    write_csv(os.path.join(out, "not_interested.csv"), DISMISSED_COLUMNS, dismissed)
    write_csv(os.path.join(out, "needs_review.csv"), REVIEW_COLUMNS,
              [dict(zip(REVIEW_COLUMNS, item)) for item in review])
    write_bundle(os.path.join(out, "vault-import.json"), vault, library, candidates, dismissed, review)

    kinds = Counter(row["kind"] or "unknown" for row in library)
    rated = sum(1 for row in library if row["rating"])
    unreadable = sum(1 for item in review if item[2] == "note could not be read")
    print("Vault: %s" % vault)
    print("Wrote to: %s" % out)
    print("  library.csv         %d titles (%s); %d with a rating" % (
        len(library), ", ".join("%d %s" % (n, k) for k, n in sorted(kinds.items())), rated))
    print("  candidates.csv      %d titles" % len(candidates))
    print("  not_interested.csv  %d titles" % len(dismissed))
    print("  needs_review.csv    %d items to check by hand" % len(review))
    print("  vault-import.json   all of the above, for the app's import")
    for issue, count in Counter(item[2] for item in review).most_common():
        print("      %3d  %s" % (count, issue))
    return 1 if unreadable else 0


if __name__ == "__main__":
    sys.exit(main())
