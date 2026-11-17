// Household data: everything the household records itself. All writes go
// through here, and each one runs as a single transaction.

import { batch, exec, type Statement } from './db';
import { isValidRating, participantsFor, profilesIn } from './ratings';
import type {
  Kind,
  LibraryItem,
  Note,
  OmdbScores,
  ProfileId,
  Profiles,
  Rater,
  Status,
  TitleDetail,
  TmdbTitle,
  WatchEvent,
  Who,
} from './types';

const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const parse = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export const tmdbCacheKey = (kind: Kind, tmdbId: number) => `${kind}:${tmdbId}`;

// ------------------------------------------------------------------ profiles

export async function loadProfiles(): Promise<Profiles> {
  const rows = await exec<{ id: ProfileId; name: string }>('SELECT id, name FROM profile');
  const profiles: Profiles = { A: 'A', B: 'B' };
  for (const row of rows) profiles[row.id] = row.name;
  return profiles;
}

export async function saveProfileName(id: ProfileId, name: string): Promise<void> {
  const clean = name.trim().slice(0, 24) || id;
  await exec('UPDATE profile SET name = ? WHERE id = ?', [clean, id]);
}

// ------------------------------------------------------------------- library

interface LibraryRow {
  id: string;
  kind: Kind;
  name: string;
  year: number | null;
  tmdb_id: number | null;
  source: string;
  created_at: number;
  poster_path: string | null;
  genres: string | null;
  ratings: string | null;
  states: string | null;
  together: number;
  notes: string | null;
}

export async function listLibrary(): Promise<LibraryItem[]> {
  const rows = await exec<LibraryRow>(`
    SELECT t.id, t.kind, t.name, t.year, t.tmdb_id, t.source, t.created_at,
           json_extract(c.data, '$.posterPath') AS poster_path,
           json_extract(c.data, '$.genres') AS genres,
           (SELECT json_group_object(r.rater, r.score) FROM rating r WHERE r.title_id = t.id) AS ratings,
           (SELECT json_group_object(s.profile_id, json_object('status', s.status, 'rewatch', s.would_rewatch))
              FROM title_state s WHERE s.title_id = t.id) AS states,
           EXISTS (SELECT 1 FROM watch_event w WHERE w.title_id = t.id AND w.participants = 3) AS together,
           (SELECT group_concat(n.text, ' ') FROM title_note n WHERE n.title_id = t.id) AS notes
      FROM title t
      LEFT JOIN cache.tmdb_title c ON c.key = t.kind || ':' || t.tmdb_id`);

  return rows.map((row) => {
    const states = parse<Partial<Record<ProfileId, { status: Status | null; rewatch: number }>>>(row.states, {});
    const status: Partial<Record<ProfileId, Status>> = {};
    const wouldRewatch: Partial<Record<ProfileId, boolean>> = {};
    for (const person of ['A', 'B'] as ProfileId[]) {
      const state = states[person];
      if (state?.status) status[person] = state.status;
      if (state?.rewatch) wouldRewatch[person] = true;
    }
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      year: row.year,
      tmdbId: row.tmdb_id,
      source: row.source,
      createdAt: row.created_at,
      posterPath: row.poster_path,
      genres: parse<string[]>(row.genres, []),
      ratings: parse<Partial<Record<Rater, number>>>(row.ratings, {}),
      status,
      wouldRewatch,
      watchedTogether: Boolean(row.together),
      notes: row.notes ?? '',
    };
  });
}

// --------------------------------------------------------------------- title

interface TitleRow {
  id: string;
  kind: Kind;
  name: string;
  year: number | null;
  tmdb_id: number | null;
  tmdb_checked_at: number | null;
  imdb_id: string | null;
  source: string;
  created_at: number;
  tmdb_data: string | null;
  tmdb_fetched_at: number | null;
  omdb_data: string | null;
  omdb_fetched_at: number | null;
}

export async function getTitle(id: string): Promise<TitleDetail | undefined> {
  const [row] = await exec<TitleRow>(
    `SELECT t.*, c.data AS tmdb_data, c.fetched_at AS tmdb_fetched_at,
            o.data AS omdb_data, o.fetched_at AS omdb_fetched_at
       FROM title t
       LEFT JOIN cache.tmdb_title c ON c.key = t.kind || ':' || t.tmdb_id
       LEFT JOIN cache.omdb_rating o ON o.imdb_id = t.imdb_id
      WHERE t.id = ?`,
    [id],
  );
  if (!row) return undefined;

  const ratingRows = await exec<{ rater: Rater; score: number }>('SELECT rater, score FROM rating WHERE title_id = ?', [id]);
  const stateRows = await exec<{ profile_id: ProfileId; status: Status | null; would_rewatch: number }>(
    'SELECT profile_id, status, would_rewatch FROM title_state WHERE title_id = ?',
    [id],
  );
  const eventRows = await exec<{
    id: string;
    participants: 1 | 2 | 3;
    watched_on: string | null;
    completion: number;
    is_rewatch: number;
    source: string;
    created_at: number;
  }>(
    `SELECT id, participants, watched_on, completion, is_rewatch, source, created_at
       FROM watch_event WHERE title_id = ?
      ORDER BY COALESCE(watched_on, '') DESC, created_at DESC`,
    [id],
  );
  const noteRows = await exec<{ id: string; author: Rater; text: string; updated_at: number }>(
    'SELECT id, author, text, updated_at FROM title_note WHERE title_id = ? ORDER BY updated_at',
    [id],
  );

  const ratings: Partial<Record<Rater, number>> = {};
  for (const rating of ratingRows) ratings[rating.rater] = rating.score;
  const status: Partial<Record<ProfileId, Status>> = {};
  const wouldRewatch: Partial<Record<ProfileId, boolean>> = {};
  for (const state of stateRows) {
    if (state.status) status[state.profile_id] = state.status;
    if (state.would_rewatch) wouldRewatch[state.profile_id] = true;
  }
  const events: WatchEvent[] = eventRows.map((event) => ({
    id: event.id,
    participants: event.participants,
    watchedOn: event.watched_on,
    completion: event.completion,
    isRewatch: Boolean(event.is_rewatch),
    source: event.source,
    createdAt: event.created_at,
  }));
  const notes: Note[] = noteRows.map((note) => ({
    id: note.id,
    author: note.author,
    text: note.text,
    updatedAt: note.updated_at,
  }));

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    year: row.year,
    tmdbId: row.tmdb_id,
    tmdbCheckedAt: row.tmdb_checked_at,
    imdbId: row.imdb_id,
    source: row.source,
    createdAt: row.created_at,
    ratings,
    status,
    wouldRewatch,
    events,
    notes,
    tmdb: parse<TmdbTitle | null>(row.tmdb_data, null),
    tmdbFetchedAt: row.tmdb_fetched_at,
    omdb: parse<OmdbScores | null>(row.omdb_data, null),
    omdbFetchedAt: row.omdb_fetched_at,
  };
}

export async function findTitleByTmdb(kind: Kind, tmdbId: number): Promise<string | undefined> {
  const [row] = await exec<{ id: string }>('SELECT id FROM title WHERE kind = ? AND tmdb_id = ?', [kind, tmdbId]);
  return row?.id;
}

export interface NewTitle {
  kind: Kind;
  name: string;
  year: number | null;
  tmdbId?: number | null;
  source: 'search' | 'stub' | 'vault';
}

export async function addTitle(input: NewTitle): Promise<string> {
  if (input.tmdbId != null) {
    const existing = await findTitleByTmdb(input.kind, input.tmdbId);
    if (existing) return existing;
  }
  const id = uuid();
  const at = now();
  await exec(
    `INSERT INTO title (id, kind, name, year, tmdb_id, tmdb_checked_at, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.kind, input.name.trim(), input.year, input.tmdbId ?? null, input.tmdbId != null ? at : null, input.source, at, at],
  );
  return id;
}

/**
 * Links a title to a TMDB entry. If another title already has that entry,
 * the two are merged into the existing one, which keeps its own ratings and
 * states where both have them. Returns the id of the surviving title.
 */
export async function linkTitle(id: string, kind: Kind, tmdbId: number, name: string, year: number | null): Promise<string> {
  const existing = await findTitleByTmdb(kind, tmdbId);
  const at = now();
  if (existing && existing !== id) {
    await batch([
      { sql: 'UPDATE OR IGNORE rating SET title_id = ? WHERE title_id = ?', bind: [existing, id] },
      { sql: 'UPDATE OR IGNORE title_state SET title_id = ? WHERE title_id = ?', bind: [existing, id] },
      { sql: 'UPDATE watch_event SET title_id = ? WHERE title_id = ?', bind: [existing, id] },
      { sql: 'UPDATE title_note SET title_id = ? WHERE title_id = ?', bind: [existing, id] },
      { sql: 'DELETE FROM title WHERE id = ?', bind: [id] },
      { sql: 'UPDATE title SET updated_at = ? WHERE id = ?', bind: [at, existing] },
    ]);
    return existing;
  }
  await exec(
    'UPDATE title SET kind = ?, tmdb_id = ?, tmdb_checked_at = ?, name = ?, year = ?, updated_at = ? WHERE id = ?',
    [kind, tmdbId, at, name, year, at, id],
  );
  return id;
}

export async function removeTitle(id: string): Promise<void> {
  await exec('DELETE FROM title WHERE id = ?', [id]);
}

/** Records that TMDB data for this title was just fetched, and fills in its IMDb id. */
export async function markTmdbChecked(id: string, imdbId: string | null): Promise<void> {
  await exec(
    'UPDATE title SET tmdb_checked_at = ?, imdb_id = COALESCE(imdb_id, ?), updated_at = ? WHERE id = ?',
    [now(), imdbId, now(), id],
  );
}

// ---------------------------------------------------------- ratings & states

function ratingStatement(rater: Rater, titleId: string, score: number | null, source: string): Statement {
  if (score == null) return { sql: 'DELETE FROM rating WHERE rater = ? AND title_id = ?', bind: [rater, titleId] };
  if (!isValidRating(score)) throw new Error(`Invalid rating: ${score}`);
  return {
    sql: `INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (rater, title_id) DO UPDATE SET score = excluded.score, rated_at = excluded.rated_at, source = excluded.source`,
    bind: [rater, titleId, score, now(), source],
  };
}

function stateStatement(person: ProfileId, titleId: string, status: Status | null): Statement {
  return {
    sql: `INSERT INTO title_state (profile_id, title_id, status, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, title_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    bind: [person, titleId, status, now()],
  };
}

/** source records how the rating was given: 'manual', or 'agree' / 'adjust' from the shared-ratings review. */
export async function setRating(rater: Rater, titleId: string, score: number | null, source = 'manual'): Promise<void> {
  await batch([ratingStatement(rater, titleId, score, source)]);
}

export async function setStatus(person: ProfileId, titleId: string, status: Status | null): Promise<void> {
  await batch([stateStatement(person, titleId, status)]);
}

export async function setStatusFor(who: Who, titleId: string, status: Status | null): Promise<void> {
  await batch(profilesIn(participantsFor(who)).map((person) => stateStatement(person, titleId, status)));
}

export async function setWouldRewatch(person: ProfileId, titleId: string, value: boolean): Promise<void> {
  await exec(
    `INSERT INTO title_state (profile_id, title_id, status, would_rewatch, updated_at) VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (profile_id, title_id) DO UPDATE SET would_rewatch = excluded.would_rewatch, updated_at = excluded.updated_at`,
    [person, titleId, value ? 1 : 0, now()],
  );
}

// ------------------------------------------------------------- watch events

export type WatchOutcome = 'finished' | 'watching' | 'stopped';

const OUTCOME_STATUS: Record<WatchOutcome, Status> = { finished: 'watched', watching: 'watching', stopped: 'dropped' };

export interface WatchInput {
  titleId: string;
  who: Who;
  /** YYYY-MM-DD, or null when the date is not known. */
  watchedOn: string | null;
  /** 'watching' is for a series still in progress. */
  outcome: WatchOutcome;
  /** Ratings to save with the watch. Leave a rater out to keep its rating. */
  ratings: Partial<Record<Rater, number>>;
}

export async function markWatched(input: WatchInput): Promise<void> {
  const participants = participantsFor(input.who);
  const people = profilesIn(participants);
  const [previous] = await exec<{ n: number }>(
    'SELECT COUNT(*) AS n FROM watch_event WHERE title_id = ? AND (participants & ?) != 0 AND completion = 1',
    [input.titleId, participants],
  );
  const statements: Statement[] = [
    {
      sql: `INSERT INTO watch_event (id, title_id, participants, watched_on, completion, is_rewatch, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`,
      bind: [
        uuid(),
        input.titleId,
        participants,
        input.watchedOn,
        input.outcome === 'finished' ? 1 : 0.5,
        input.outcome === 'finished' && previous.n > 0 ? 1 : 0,
        now(),
      ],
    },
    ...people.map((person) => stateStatement(person, input.titleId, OUTCOME_STATUS[input.outcome])),
  ];
  for (const [rater, score] of Object.entries(input.ratings) as [Rater, number][]) {
    statements.push(ratingStatement(rater, input.titleId, score, 'manual'));
  }
  await batch(statements);
}

export async function deleteWatchEvent(id: string): Promise<void> {
  await exec('DELETE FROM watch_event WHERE id = ?', [id]);
}

// --------------------------------------------------------------------- notes

export async function saveNote(titleId: string, author: Rater, text: string, id?: string): Promise<void> {
  const clean = text.trim();
  if (id && !clean) {
    await exec('DELETE FROM title_note WHERE id = ?', [id]);
  } else if (id) {
    await exec('UPDATE title_note SET text = ?, author = ?, updated_at = ? WHERE id = ?', [clean, author, now(), id]);
  } else if (clean) {
    await exec('INSERT INTO title_note (id, title_id, author, text, updated_at) VALUES (?, ?, ?, ?, ?)', [
      uuid(),
      titleId,
      author,
      clean,
      now(),
    ]);
  }
}

// --------------------------------------------------------------------- stats

export async function householdCounts(): Promise<{ titles: number; ratings: number; unmatched: number }> {
  const [row] = await exec<{ titles: number; ratings: number; unmatched: number }>(`
    SELECT (SELECT COUNT(*) FROM title) AS titles,
           (SELECT COUNT(*) FROM rating) AS ratings,
           (SELECT COUNT(*) FROM title WHERE tmdb_id IS NULL) AS unmatched`);
  return row;
}

export type { TmdbTitle };
