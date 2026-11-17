// Imports the vault file: stage every row, match each one to a TMDB entry,
// then write it into the household's records.
//
// Rules:
// - A row is matched only when the match is unambiguous (see vault.ts);
//   anything else waits for a person in the review list.
// - Importing fills gaps and never overwrites: a rating, status or note
//   already in the app is kept. The app is the source of truth.
// - Each row is remembered by the vault note it came from, so importing an
//   updated vault later adds only what is new.
// - Progress is saved row by row, so closing the app loses nothing.

import { batch, exec, type Statement } from './db';
import { refreshAll, saveTmdb } from './gateway/refresh';
import { fetchDetails, searchTitles, ServiceError } from './gateway/tmdb';
import { checkNetwork } from './network';
import { findTitleByTmdb, markTmdbChecked } from './repo';
import { app, changed } from './state.svelte';
import type { Kind, ProfileId, SearchResult, Status, TmdbTitle } from './types';
import {
  decide,
  mergeNote,
  pickByCreators,
  type MatchQuery,
  type VaultBundle,
  type VaultCandidateRow,
  type VaultLibraryRow,
  type VaultNotInterestedRow,
} from './vault';

export type RowType = 'library' | 'candidate' | 'not_interested';
type RowData = VaultLibraryRow | VaultCandidateRow | VaultNotInterestedRow;

export interface ImportRow {
  id: number;
  rowType: RowType;
  sourceRef: string;
  data: RowData;
  state: 'pending' | 'imported' | 'review' | 'skipped';
  titleId: string | null;
  reason: string | null;
  options: SearchResult[] | null;
}

export interface ImportCheck {
  id: number;
  sourceRef: string;
  title: string;
  issue: string;
  detail: string;
  done: boolean;
  titleId: string | null;
}

export interface ImportStatus {
  pending: number;
  imported: number;
  review: number;
  skipped: number;
  checksOpen: number;
  checksDone: number;
}

const uuid = () => crypto.randomUUID();
const ROW_ORDER = "CASE row_type WHEN 'library' THEN 0 WHEN 'not_interested' THEN 1 ELSE 2 END";

export function sourceRefFor(rowType: RowType, data: RowData): string {
  if (rowType === 'not_interested') {
    return `${data.source_file || 'dismissed'}#${data.title}${data.year ? ` (${data.year})` : ''}`;
  }
  return data.source_file;
}

// ------------------------------------------------------------------ status

export async function importStatus(): Promise<ImportStatus> {
  const states = await exec<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM import_row GROUP BY state');
  const [checks] = await exec<{ open: number; done: number }>(
    'SELECT COALESCE(SUM(done = 0), 0) AS open, COALESCE(SUM(done = 1), 0) AS done FROM import_check',
  );
  const count = (state: string) => states.find((row) => row.state === state)?.n ?? 0;
  return {
    pending: count('pending'),
    imported: count('imported'),
    review: count('review'),
    skipped: count('skipped'),
    checksOpen: checks.open,
    checksDone: checks.done,
  };
}

interface RowRecord {
  id: number;
  row_type: RowType;
  source_ref: string;
  data: string;
  state: ImportRow['state'];
  title_id: string | null;
  reason: string | null;
  options: string | null;
}

const toRow = (record: RowRecord): ImportRow => ({
  id: record.id,
  rowType: record.row_type,
  sourceRef: record.source_ref,
  data: JSON.parse(record.data) as RowData,
  state: record.state,
  titleId: record.title_id,
  reason: record.reason,
  options: record.options ? (JSON.parse(record.options) as SearchResult[]) : null,
});

export async function listReviewRows(): Promise<ImportRow[]> {
  const records = await exec<RowRecord>(
    `SELECT r.*, m.data AS options FROM import_row r LEFT JOIN cache.import_match m ON m.row_id = r.id
      WHERE r.state = 'review' ORDER BY ${ROW_ORDER}, r.id`,
  );
  return records.map(toRow);
}

async function getRow(id: number): Promise<ImportRow> {
  const [record] = await exec<RowRecord>('SELECT r.*, NULL AS options FROM import_row r WHERE r.id = ?', [id]);
  if (!record) throw new Error('That import row no longer exists.');
  return toRow(record);
}

export async function listChecks(): Promise<ImportCheck[]> {
  const records = await exec<{
    id: number;
    source_ref: string;
    title: string;
    issue: string;
    detail: string;
    done: number;
    title_id: string | null;
  }>(
    `SELECT c.id, c.source_ref, c.title, c.issue, c.detail, c.done,
            (SELECT t.id FROM title t WHERE t.source_ref = c.source_ref LIMIT 1) AS title_id
       FROM import_check c ORDER BY c.done, c.id`,
  );
  return records.map((record) => ({
    id: record.id,
    sourceRef: record.source_ref,
    title: record.title,
    issue: record.issue,
    detail: record.detail,
    done: Boolean(record.done),
    titleId: record.title_id,
  }));
}

// ----------------------------------------------------------------- staging

/** Stores the file's rows to be matched. Rows already imported, staged or skipped are left out. */
export async function stageBundle(bundle: VaultBundle): Promise<{ staged: number; alreadyHere: number }> {
  const known = new Set(
    (
      await exec<{ ref: string }>(`
        SELECT source_ref AS ref FROM title WHERE source_ref IS NOT NULL
        UNION SELECT source_ref FROM pool_seed WHERE source_ref IS NOT NULL
        UNION SELECT source_ref FROM import_skip
        UNION SELECT source_ref FROM import_row`)
    ).map((row) => row.ref),
  );
  const at = Date.now();
  const statements: Statement[] = [];
  let staged = 0;
  let alreadyHere = 0;

  const stage = (rowType: RowType, data: RowData) => {
    const ref = sourceRefFor(rowType, data);
    if (known.has(ref)) {
      alreadyHere++;
      return;
    }
    known.add(ref);
    staged++;
    statements.push({
      sql: `INSERT INTO import_row (batch, row_type, source_ref, data, state, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      bind: [bundle.generatedAt, rowType, ref, JSON.stringify(data), at],
    });
  };
  bundle.library.forEach((row) => stage('library', row));
  bundle.notInterested.forEach((row) => stage('not_interested', row));
  bundle.candidates.forEach((row) => stage('candidate', row));
  for (const check of bundle.checks) {
    statements.push({
      sql: `INSERT OR IGNORE INTO import_check (batch, source_ref, title, issue, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      bind: [bundle.generatedAt, check.file, check.title, check.issue, check.detail, at],
    });
  }
  if (statements.length > 0) await batch(statements);
  changed();
  return { staged, alreadyHere };
}

// ---------------------------------------------------------------- matching

function queryFor(row: ImportRow): MatchQuery {
  if (row.rowType === 'not_interested') {
    return { searchTitle: row.data.title, hint: '', year: row.data.year, kind: '', creators: [] };
  }
  const data = row.data as VaultLibraryRow | VaultCandidateRow;
  return { searchTitle: data.search_title || data.title, hint: data.title_hint, year: data.year, kind: data.kind, creators: data.creators };
}

type Found = { match: SearchResult; details: TmdbTitle } | { options: SearchResult[]; reason: string };

/** Searches narrowly first (type and year), then more broadly, accepting only an unambiguous match. */
async function findMatch(query: MatchQuery): Promise<Found> {
  const key = app.tmdbKey;
  const anyKind: MatchQuery = { ...query, kind: '' };
  const attempts: { query: MatchQuery; search: () => Promise<SearchResult[]> }[] = [];
  if (query.kind) {
    const kind = query.kind as Kind;
    attempts.push({ query, search: () => searchTitles(key, query.searchTitle, { kind, year: query.year }) });
    if (query.year != null) attempts.push({ query, search: () => searchTitles(key, query.searchTitle, { kind }) });
  }
  // Last, any type: the vault sometimes files a series as a documentary film.
  attempts.push({ query: anyKind, search: () => searchTitles(key, query.searchTitle) });

  const seen = new Map<string, SearchResult>();
  for (const attempt of attempts) {
    const results = await attempt.search();
    for (const result of results) seen.set(`${result.kind}:${result.tmdbId}`, result);
    const decision = decide(attempt.query, results);
    if (decision.type === 'accept') {
      return { match: decision.match, details: await fetchDetails(key, decision.match.kind, decision.match.tmdbId, app.region) };
    }
    if (decision.type === 'tiebreak') {
      const detailed = await Promise.all(
        decision.options.map(async (result) => ({ result, details: await fetchDetails(key, result.kind, result.tmdbId, app.region) })),
      );
      const picked = pickByCreators(
        query,
        detailed.map((entry) => ({ result: entry.result, makers: [...entry.details.directors, ...entry.details.writers] })),
      );
      const chosen = detailed.find((entry) => entry.result === picked);
      if (chosen) return { match: chosen.result, details: chosen.details };
      return { options: decision.options, reason: 'More than one title matches, and the creators did not settle it.' };
    }
  }
  const final = decide(anyKind, [...seen.values()]);
  if (final.type === 'review') return { options: final.options, reason: final.reason };
  return { options: final.type === 'tiebreak' ? final.options : [final.match], reason: 'More than one title could match.' };
}

// Writes are made one row at a time, so two rows that match the same title
// cannot both create it.
let writeLock: Promise<unknown> = Promise.resolve();
function locked<T>(task: () => Promise<T>): Promise<T> {
  const next = writeLock.then(task, task);
  writeLock = next.catch(() => undefined);
  return next;
}

function fillStatus(person: ProfileId, titleId: string, status: Status, at: number): Statement {
  return {
    sql: `INSERT INTO title_state (profile_id, title_id, status, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, title_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
          WHERE title_state.status IS NULL`,
    bind: [person, titleId, status, at],
  };
}

/** Writes one row into the household's records, filling gaps only. */
function applyRow(row: ImportRow, match: SearchResult | null, details: TmdbTitle | null): Promise<void> {
  return locked(async () => {
    const at = Date.now();
    const done = (titleId: string | null): Statement[] => [
      { sql: `UPDATE import_row SET state = 'imported', title_id = ?, reason = NULL, updated_at = ? WHERE id = ?`, bind: [titleId, at, row.id] },
      { sql: 'DELETE FROM cache.import_match WHERE row_id = ?', bind: [row.id] },
    ];

    if (row.rowType === 'candidate' && (row.data as VaultCandidateRow).destination === 'candidate_pool') {
      if (!match) throw new Error('A recommendation can only be kept with a match.');
      const data = row.data as VaultCandidateRow;
      await batch([
        {
          sql: `INSERT OR IGNORE INTO pool_seed (id, kind, name, year, tmdb_id, tmdb_checked_at, source, source_ref, match_score, added_at)
                VALUES (?, ?, ?, ?, ?, ?, 'vault', ?, ?, ?)`,
          bind: [uuid(), match.kind, data.title, data.year ?? match.year, match.tmdbId, at, row.sourceRef, data.match_score, at],
        },
        ...done(null),
      ]);
      return;
    }

    const data = row.data;
    const [byRef] = await exec<{ id: string }>('SELECT id FROM title WHERE source_ref = ?', [row.sourceRef]);
    const byTmdb = match ? await findTitleByTmdb(match.kind, match.tmdbId) : undefined;
    const titleId = byRef?.id ?? byTmdb ?? uuid();
    const statements: Statement[] = [];

    if (!byRef && !byTmdb) {
      const kind: Kind = match?.kind ?? (('kind' in data && data.kind) || 'movie');
      statements.push({
        sql: `INSERT INTO title (id, kind, name, year, tmdb_id, tmdb_checked_at, source, source_ref, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'vault', ?, ?, ?)`,
        bind: [titleId, kind, data.title, data.year ?? match?.year ?? null, match?.tmdbId ?? null, match ? at : null, row.sourceRef, at, at],
      });
    } else {
      statements.push({ sql: 'UPDATE title SET source_ref = COALESCE(source_ref, ?), updated_at = ? WHERE id = ?', bind: [row.sourceRef, at, titleId] });
    }

    if (row.rowType === 'library') {
      const library = data as VaultLibraryRow;
      statements.push(fillStatus('A', titleId, 'watched', at), fillStatus('B', titleId, 'watched', at));
      if (library.rating != null) {
        statements.push({
          sql: `INSERT INTO rating (rater, title_id, score, rated_at, source) VALUES ('US', ?, ?, ?, 'vault')
                ON CONFLICT (rater, title_id) DO NOTHING`,
          bind: [titleId, library.rating, at],
        });
      }
      // The vault records shared viewings without real dates.
      statements.push({
        sql: `INSERT INTO watch_event (id, title_id, participants, watched_on, completion, is_rewatch, source, created_at)
              SELECT ?, ?, 3, NULL, 1, 0, 'vault', ?
               WHERE NOT EXISTS (SELECT 1 FROM watch_event WHERE title_id = ? AND source = 'vault')`,
        bind: [uuid(), titleId, at, titleId],
      });
      const note = mergeNote(library);
      if (note) {
        statements.push({
          sql: `INSERT INTO title_note (id, title_id, author, text, updated_at)
                SELECT ?, ?, 'US', ?, ? WHERE NOT EXISTS (SELECT 1 FROM title_note WHERE title_id = ? AND text = ?)`,
          bind: [uuid(), titleId, note, at, titleId, note],
        });
      }
    } else {
      const status: Status = row.rowType === 'not_interested' ? 'not_interested' : 'watchlist';
      statements.push(fillStatus('A', titleId, status, at), fillStatus('B', titleId, status, at));
    }

    await batch([...statements, ...done(titleId)]);
    if (details) await markTmdbChecked(titleId, details.imdbId);
  });
}

async function saveOptions(rowId: number, options: SearchResult[], reason: string): Promise<void> {
  await batch([
    {
      sql: `INSERT INTO cache.import_match (row_id, data, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT (row_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      bind: [rowId, JSON.stringify(options), Date.now()],
    },
    { sql: `UPDATE import_row SET state = 'review', reason = ?, updated_at = ? WHERE id = ?`, bind: [reason, Date.now(), rowId] },
  ]);
}

/** True for errors that will repeat for every row, so the run should stop. */
const stopsTheRun = (error: unknown) =>
  error instanceof TypeError || (error instanceof ServiceError && [0, 401, 429].includes(error.status));

async function matchRow(row: ImportRow): Promise<void> {
  try {
    const found = await findMatch(queryFor(row));
    if ('match' in found) {
      await saveTmdb(found.details, app.region);
      await applyRow(row, found.match, found.details);
    } else {
      await saveOptions(row.id, found.options, found.reason);
    }
  } catch (error) {
    if (stopsTheRun(error)) throw error;
    await saveOptions(row.id, [], `Could not be matched: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface MatchProgress {
  done: number;
  total: number;
}

let running: Promise<string> | undefined;

export const isMatching = () => running !== undefined;

/**
 * Matches every pending row. Resolves to '' when finished, or to the reason
 * it stopped early (rows not reached stay pending for next time).
 */
export function runMatching(): Promise<string> {
  running ??= matchAll((progress) => (app.importProgress = progress)).finally(() => {
    running = undefined;
    app.importProgress = null;
    changed();
  });
  return running;
}

async function matchAll(onProgress: (progress: MatchProgress) => void): Promise<string> {
  if (!app.tmdbKey) return 'Matching needs a TMDB key. Add one in Settings.';
  if (!(await checkNetwork())) return 'Matching needs a network connection.';

  const records = await exec<RowRecord>(
    `SELECT r.*, NULL AS options FROM import_row r WHERE r.state = 'pending' ORDER BY ${ROW_ORDER}, r.id`,
  );
  const queue = records.map(toRow);
  const total = queue.length;
  let done = 0;
  let stopped = '';
  onProgress({ done, total });

  // Two rows at a time keeps both of TMDB's allowed requests in flight.
  const worker = async () => {
    while (!stopped && queue.length > 0) {
      const row = queue.shift() as ImportRow;
      try {
        await matchRow(row);
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
        if (error instanceof TypeError) stopped = 'The network connection was lost. Matching will continue next time.';
        return;
      }
      done++;
      onProgress({ done, total });
      if (done % 10 === 0) changed();
    }
  };
  await Promise.all([worker(), worker()]);

  if (!stopped) {
    // Review scores and posters for everything just imported.
    void refreshAll().catch(() => {});
  }
  return stopped;
}

// --------------------------------------------------------------- resolving

/** A person chose this match for a row in the review list. */
export async function resolveRow(rowId: number, option: SearchResult): Promise<void> {
  const row = await getRow(rowId);
  const details = await fetchDetails(app.tmdbKey, option.kind, option.tmdbId, app.region);
  await saveTmdb(details, app.region);
  await applyRow(row, option, details);
  changed();
}

/** Keeps a watched title's ratings and notes without a TMDB entry; "Find it" links it later. */
export async function importWithoutMatch(rowId: number): Promise<void> {
  const row = await getRow(rowId);
  if (row.rowType === 'candidate' && (row.data as VaultCandidateRow).destination === 'candidate_pool') {
    throw new Error('A recommendation can only be kept with a match. Skip it instead.');
  }
  await applyRow(row, null, null);
  changed();
}

export async function skipRow(rowId: number): Promise<void> {
  const row = await getRow(rowId);
  await batch([
    { sql: `UPDATE import_row SET state = 'skipped', updated_at = ? WHERE id = ?`, bind: [Date.now(), rowId] },
    { sql: 'INSERT OR IGNORE INTO import_skip (source_ref, skipped_at) VALUES (?, ?)', bind: [row.sourceRef, Date.now()] },
    { sql: 'DELETE FROM cache.import_match WHERE row_id = ?', bind: [rowId] },
  ]);
  changed();
}

/** Searches again for one row, e.g. after the suggestions were cleared from the cache. */
export async function searchAgain(rowId: number): Promise<void> {
  if (!app.tmdbKey) throw new Error('Searching needs a TMDB key. Add one in Settings.');
  await matchRow(await getRow(rowId));
  changed();
}

export async function setCheckDone(id: number, done: boolean): Promise<void> {
  await exec('UPDATE import_check SET done = ?, updated_at = ? WHERE id = ?', [done ? 1 : 0, Date.now(), id]);
  changed();
}

/**
 * Clears the finished rows. The checklist and the list of skipped notes are
 * kept, so importing an updated vault later does not ask again.
 */
export async function finishImport(): Promise<void> {
  await batch([
    { sql: `DELETE FROM import_row WHERE state IN ('imported', 'skipped')` },
    { sql: 'DELETE FROM cache.import_match WHERE row_id NOT IN (SELECT id FROM import_row)' },
  ]);
  changed();
}
