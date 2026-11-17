// Database schemas, as ordered migrations. A database's PRAGMA user_version
// is the number of migrations already applied to it.
//
// household.db is the household's own record: the source of truth, and the
// only file that is backed up. cache.db holds data fetched from outside
// services; it can be deleted at any time and is rebuilt by refreshing.

export const HOUSEHOLD_MIGRATIONS: string[] = [
  // 1. Phase 0 device check. Devices that ran it already have these tables.
  `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spike_boot (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT    NOT NULL,
    online     INTEGER NOT NULL,
    standalone INTEGER NOT NULL
  );
  `,

  // 2. Phase 1 library.
  `
  CREATE TABLE profile (
    id   TEXT PRIMARY KEY CHECK (id IN ('A', 'B')),
    name TEXT NOT NULL
  );
  INSERT INTO profile (id, name) VALUES ('A', 'A'), ('B', 'B');

  CREATE TABLE title (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    name            TEXT NOT NULL,
    year            INTEGER,
    tmdb_id         INTEGER,
    tmdb_checked_at INTEGER,
    imdb_id         TEXT,
    tvmaze_id       INTEGER,
    source          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX title_tmdb ON title (kind, tmdb_id) WHERE tmdb_id IS NOT NULL;
  CREATE INDEX title_imdb ON title (imdb_id) WHERE imdb_id IS NOT NULL;

  CREATE TABLE rating (
    rater    TEXT NOT NULL CHECK (rater IN ('A', 'B', 'US')),
    title_id TEXT NOT NULL REFERENCES title (id) ON DELETE CASCADE,
    score    REAL NOT NULL CHECK (score >= 1 AND score <= 10 AND score * 2 = CAST(score * 2 AS INTEGER)),
    rated_at INTEGER NOT NULL,
    source   TEXT NOT NULL,
    PRIMARY KEY (rater, title_id)
  );
  CREATE INDEX rating_title ON rating (title_id);

  CREATE TABLE title_state (
    profile_id    TEXT NOT NULL REFERENCES profile (id),
    title_id      TEXT NOT NULL REFERENCES title (id) ON DELETE CASCADE,
    status        TEXT CHECK (status IN ('watchlist', 'watching', 'watched', 'dropped', 'not_interested')),
    would_rewatch INTEGER NOT NULL DEFAULT 0 CHECK (would_rewatch IN (0, 1)),
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (profile_id, title_id)
  );
  CREATE INDEX title_state_title ON title_state (title_id);

  CREATE TABLE watch_event (
    id           TEXT PRIMARY KEY,
    title_id     TEXT NOT NULL REFERENCES title (id) ON DELETE CASCADE,
    episode_id   TEXT,
    participants INTEGER NOT NULL CHECK (participants IN (1, 2, 3)),
    watched_on   TEXT,
    completion   REAL NOT NULL DEFAULT 1 CHECK (completion >= 0 AND completion <= 1),
    is_rewatch   INTEGER NOT NULL DEFAULT 0 CHECK (is_rewatch IN (0, 1)),
    source       TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX watch_event_title ON watch_event (title_id);

  CREATE TABLE title_note (
    id         TEXT PRIMARY KEY,
    title_id   TEXT NOT NULL REFERENCES title (id) ON DELETE CASCADE,
    author     TEXT NOT NULL CHECK (author IN ('A', 'B', 'US')),
    text       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX title_note_title ON title_note (title_id);
  `,

  // 3. Phase 1 vault import. source_ref ties a title to the vault note it
  // came from, so importing an updated vault adds only what is new.
  `
  ALTER TABLE title ADD COLUMN source_ref TEXT;
  CREATE INDEX title_source_ref ON title (source_ref) WHERE source_ref IS NOT NULL;

  CREATE TABLE pool_seed (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    name            TEXT NOT NULL,
    year            INTEGER,
    tmdb_id         INTEGER,
    tmdb_checked_at INTEGER,
    source          TEXT NOT NULL,
    source_ref      TEXT,
    match_score     TEXT,
    added_at        INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX pool_seed_tmdb ON pool_seed (kind, tmdb_id) WHERE tmdb_id IS NOT NULL;
  CREATE INDEX pool_seed_source_ref ON pool_seed (source_ref) WHERE source_ref IS NOT NULL;

  CREATE TABLE import_row (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    batch      TEXT NOT NULL,
    row_type   TEXT NOT NULL CHECK (row_type IN ('library', 'candidate', 'not_interested')),
    source_ref TEXT NOT NULL UNIQUE,
    data       TEXT NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('pending', 'imported', 'review', 'skipped')),
    title_id   TEXT,
    reason     TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX import_row_state ON import_row (state);

  CREATE TABLE import_check (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    batch      TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title      TEXT NOT NULL,
    issue      TEXT NOT NULL,
    detail     TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    updated_at INTEGER NOT NULL,
    UNIQUE (source_ref, issue)
  );

  CREATE TABLE import_skip (
    source_ref TEXT PRIMARY KEY,
    skipped_at INTEGER NOT NULL
  );
  `,
];

export const CACHE_MIGRATIONS: string[] = [
  `
  CREATE TABLE cache.tmdb_title (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    region     TEXT,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE cache.omdb_rating (
    imdb_id    TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE cache.fetch_failure (
    source      TEXT NOT NULL,
    key         TEXT NOT NULL,
    attempts    INTEGER NOT NULL,
    retry_after INTEGER NOT NULL,
    last_error  TEXT NOT NULL,
    PRIMARY KEY (source, key)
  );
  CREATE TABLE cache.gateway_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // 2. TMDB matches offered for import rows that need a person to choose.
  `
  CREATE TABLE cache.import_match (
    row_id     INTEGER PRIMARY KEY,
    data       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
];

/**
 * Settings that belong to one device, not the household. Backups leave them
 * out, and a restore keeps the device's own values. The API keys are here so
 * a backup file never carries them.
 */
export const DEVICE_ONLY_SETTINGS_SQL =
  "key IN ('tmdb_key', 'omdb_key', 'offline_seen', 'poster_offline_seen', 'poster_url') OR key LIKE 'result\\_%' ESCAPE '\\'";
