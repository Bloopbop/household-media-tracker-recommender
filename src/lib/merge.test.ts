// Combining two phones' data, on real SQLite (in memory) with hand-written rows.

import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { emptySummary, hasNews, runMerge } from './merge';
import { HOUSEHOLD_MIGRATIONS } from './schema';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
let sqlite3: Sqlite3;
let counter = 0;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function phone(name: string): { db: Database; file: string } {
  const file = `/${name}-${++counter}.db`;
  const db = new sqlite3.oo1.DB(file, 'c');
  db.exec('PRAGMA foreign_keys = ON');
  HOUSEHOLD_MIGRATIONS.forEach((sql, index) => {
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${index + 1}`);
  });
  return { db, file };
}

const T0 = 1_700_000_000_000;

/** What both phones have after the iPhone was restored from the S24's backup. */
function restored(db: Database): void {
  db.exec(`
    INSERT INTO title (id, kind, name, year, tmdb_id, source, created_at, updated_at) VALUES
      ('t1', 'movie', 'Shared One', 2001, 101, 'vault', ${T0}, ${T0}),
      ('t2', 'movie', 'Shared Two', 2002, 102, 'vault', ${T0}, ${T0}),
      ('t3', 'series', 'Unmatched Stub', NULL, NULL, 'stub', ${T0}, ${T0});
    INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES
      ('US', 't1', 8, ${T0}, 'vault'), ('US', 't2', 7, ${T0}, 'vault');
    INSERT INTO title_state (profile_id, title_id, status, would_rewatch, updated_at) VALUES
      ('A', 't1', 'watched', 0, ${T0}), ('B', 't1', 'watched', 0, ${T0});
    INSERT INTO watch_event (id, title_id, participants, watched_on, completion, is_rewatch, source, created_at) VALUES
      ('w1', 't1', 3, '2026-01-01', 1, 0, 'vault', ${T0});
  `);
}

const all = (db: Database, sql: string) => db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) as Record<string, unknown>[];
const one = (db: Database, sql: string) => db.selectValue(sql);

/** The S24 (this phone) and the iPhone (the other), restored alike, then used separately. */
function divergedPhones() {
  const s24 = phone('s24');
  const iphone = phone('iphone');
  restored(s24.db);
  restored(iphone.db);
  const later = T0 + 86_400_000;
  // On the iPhone: Julie's own rating of t1, a new title with a rating, a watch, a note and two signals.
  iphone.db.exec(`
    INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES ('B', 't1', 9.5, ${later}, 'manual');
    UPDATE rating SET score = 6, rated_at = ${later} WHERE rater = 'US' AND title_id = 't2';
    INSERT INTO title (id, kind, name, year, tmdb_id, source, created_at, updated_at) VALUES
      ('i-new', 'movie', 'Only On iPhone', 2020, 500, 'slate', ${later}, ${later}),
      ('i-dup', 'movie', 'Added On Both', 2021, 600, 'search', ${later}, ${later});
    INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES
      ('B', 'i-new', 9, ${later}, 'slate'), ('B', 'i-dup', 8, ${later}, 'manual');
    INSERT INTO title_state (profile_id, title_id, status, would_rewatch, updated_at) VALUES
      ('B', 'i-new', 'watched', 0, ${later}), ('B', 't2', 'not_interested', 0, ${later});
    UPDATE title_state SET would_rewatch = 0, updated_at = ${T0 + 1000} WHERE profile_id = 'A' AND title_id = 't1';
    INSERT INTO watch_event (id, title_id, participants, watched_on, completion, is_rewatch, source, created_at) VALUES
      ('w-i', 'i-new', 2, NULL, 1, 0, 'slate', ${later});
    INSERT INTO title_note (id, title_id, author, text, updated_at) VALUES ('n1', 'i-dup', 'B', 'Loved the ending', ${later});
    INSERT INTO signal (id, at, mode, type, title_key, title_id, slate_id, rank, session, arm) VALUES
      ('s1', ${later}, 'B', 'impression', 'movie:500', NULL, 'slate-i', 1, 'x', 'model'),
      ('s2', ${later}, 'B', 'seen', 'movie:500', 'i-new', 'slate-i', 1, 'x', 'model'),
      ('s3', ${later}, 'B', 'not_interested', 'movie:600', 'i-dup', 'slate-i', 2, 'x', 'reviews');
    DELETE FROM watch_event WHERE id = 'w1';
  `);
  // On the S24: Keith re-rates t2 even later, flags t1 to rewatch later still, and adds the same TMDB title.
  s24.db.exec(`
    UPDATE rating SET score = 9, rated_at = ${later + 5000} WHERE rater = 'US' AND title_id = 't2';
    UPDATE title_state SET would_rewatch = 1, updated_at = ${later + 9000} WHERE profile_id = 'A' AND title_id = 't1';
    INSERT INTO title (id, kind, name, year, tmdb_id, source, created_at, updated_at) VALUES
      ('s-dup', 'movie', 'Added On Both', 2021, 600, 'slate', ${later}, ${later});
    INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES ('A', 's-dup', 7, ${later}, 'manual');
  `);
  iphone.db.close();
  s24.db.exec(`ATTACH DATABASE '${iphone.file}' AS other`);
  return s24.db;
}

describe('combining another phone’s backup', () => {
  it('counts what it would add without changing anything', () => {
    const db = divergedPhones();
    const before = one(db, 'SELECT COUNT(*) FROM rating');
    const preview = runMerge(db, false);
    expect(preview).toEqual({ titles: 1, details: 0, ratings: 3, statuses: 2, watches: 1, notes: 1, signals: 3, reactions: 2 });
    expect(hasNews(preview)).toBe(true);
    expect(one(db, 'SELECT COUNT(*) FROM rating')).toBe(before);
    expect(one(db, "SELECT name FROM sqlite_temp_master WHERE name = 'merge_map'")).toBeUndefined();
  });

  it('adds what this phone lacks, keeps the newer rating or status, and treats one TMDB title as one', () => {
    const db = divergedPhones();
    runMerge(db, true);
    // New title and everything about it.
    expect(one(db, "SELECT name FROM title WHERE id = 'i-new'")).toBe('Only On iPhone');
    expect(one(db, "SELECT score FROM rating WHERE rater = 'B' AND title_id = 'i-new'")).toBe(9);
    expect(one(db, "SELECT COUNT(*) FROM watch_event WHERE id = 'w-i'")).toBe(1);
    // Julie's own rating arrives; the later of the two shared ratings of t2 stays (the S24's).
    expect(one(db, "SELECT score FROM rating WHERE rater = 'B' AND title_id = 't1'")).toBe(9.5);
    expect(one(db, "SELECT score FROM rating WHERE rater = 'US' AND title_id = 't2'")).toBe(9);
    // Julie's Not interested arrives; Keith's later rewatch flag is not undone by the iPhone's older one.
    expect(one(db, "SELECT status FROM title_state WHERE profile_id = 'B' AND title_id = 't2'")).toBe('not_interested');
    expect(one(db, "SELECT would_rewatch FROM title_state WHERE profile_id = 'A' AND title_id = 't1'")).toBe(1);
    // The title both phones added is one title, holding both ratings and the iPhone's note.
    expect(one(db, 'SELECT COUNT(*) FROM title WHERE tmdb_id = 600')).toBe(1);
    expect(all(db, "SELECT rater, score FROM rating WHERE title_id = 's-dup' ORDER BY rater")).toEqual([
      { rater: 'A', score: 7 },
      { rater: 'B', score: 8 },
    ]);
    expect(one(db, "SELECT title_id FROM title_note WHERE id = 'n1'")).toBe('s-dup');
    // Signals come across, pointing at this phone's titles.
    expect(one(db, "SELECT title_id FROM signal WHERE id = 's3'")).toBe('s-dup');
    expect(one(db, 'SELECT COUNT(*) FROM signal')).toBe(3);
    // Deleting does not carry over: the S24 keeps the watch the iPhone deleted.
    expect(one(db, "SELECT COUNT(*) FROM watch_event WHERE id = 'w1'")).toBe(1);
    expect(one(db, 'PRAGMA foreign_key_check')).toBeUndefined();
  });

  it('adds nothing the second time', () => {
    const db = divergedPhones();
    runMerge(db, true);
    const again = runMerge(db, true);
    expect(again).toEqual(emptySummary());
    expect(hasNews(again)).toBe(false);
  });

  it('take a title’s details from the phone that changed them last, unless its match belongs to another title here', () => {
    const s24 = phone('s24');
    const iphone = phone('iphone');
    restored(s24.db);
    restored(iphone.db);
    // The S24 already holds TMDB 700 as another title; the iPhone matched its stub to it.
    s24.db.exec(`INSERT INTO title (id, kind, name, year, tmdb_id, source, created_at, updated_at)
                 VALUES ('s-x', 'movie', 'Matched Here', 1999, 700, 'search', ${T0}, ${T0})`);
    iphone.db.exec(`
      UPDATE title SET name = 'Shared One (2001)', updated_at = ${T0 + 50} WHERE id = 't1';
      UPDATE title SET tmdb_id = 700, kind = 'movie', name = 'Rematched', updated_at = ${T0 + 60} WHERE id = 't3';
    `);
    iphone.db.close();
    s24.db.exec(`ATTACH DATABASE '${iphone.file}' AS other`);
    const summary = runMerge(s24.db, true);
    expect(summary.details).toBe(1);
    expect(one(s24.db, "SELECT name FROM title WHERE id = 't1'")).toBe('Shared One (2001)');
    expect(one(s24.db, "SELECT tmdb_id FROM title WHERE id = 't3'")).toBeNull();
  });
});
