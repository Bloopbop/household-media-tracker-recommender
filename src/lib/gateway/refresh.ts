// The enrichment gateway's refresh work: keep cached TMDB and OMDb data
// fresh, delete TMDB data at the six-month limit, and cache posters.
//
// What to fetch is worked out from the data each time, so there is no queue
// to fall out of step with the library.

import { exec, getGatewayState, setGatewayState } from '../db';
import { linkTitle, markTmdbChecked, tmdbCacheKey } from '../repo';
import { checkNetwork } from '../network';
import { app, changed } from '../state.svelte';
import type { Kind, OmdbScores, TmdbTitle } from '../types';
import { fetchOmdb, omdbRemainingToday } from './omdb';
import { DAY_MS, isStale, omdbMaxAgeDays, retryDelayMs, TMDB_LIMIT_DAYS, tmdbMaxAgeDays } from './policy';
import { prefetchPosters } from './posters';
import { fetchDetails, findByImdb, ServiceError } from './tmdb';

export interface RefreshSummary {
  tmdb: number;
  omdb: number;
  relinked: number;
  posters: number;
  purged: number;
  failures: number;
  stoppedBecause: string;
}

// -------------------------------------------------------------- cache store

export async function saveTmdb(title: TmdbTitle, region: string): Promise<void> {
  await exec(
    `INSERT INTO cache.tmdb_title (key, data, region, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET data = excluded.data, region = excluded.region, fetched_at = excluded.fetched_at`,
    [tmdbCacheKey(title.kind, title.tmdbId), JSON.stringify(title), region, Date.now()],
  );
}

async function saveOmdb(imdbId: string, scores: OmdbScores | null): Promise<void> {
  await exec(
    `INSERT INTO cache.omdb_rating (imdb_id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (imdb_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
    [imdbId, JSON.stringify(scores), Date.now()],
  );
}

async function recordFailure(source: string, key: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const [row] = await exec<{ attempts: number }>('SELECT attempts FROM cache.fetch_failure WHERE source = ? AND key = ?', [source, key]);
  const attempts = (row?.attempts ?? 0) + 1;
  await exec(
    `INSERT INTO cache.fetch_failure (source, key, attempts, retry_after, last_error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (source, key) DO UPDATE SET attempts = excluded.attempts, retry_after = excluded.retry_after, last_error = excluded.last_error`,
    [source, key, attempts, Date.now() + retryDelayMs(attempts), message],
  );
}

async function clearFailure(source: string, key: string): Promise<void> {
  await exec('DELETE FROM cache.fetch_failure WHERE source = ? AND key = ?', [source, key]);
}

/** Deletes TMDB data that has reached the six-month limit. Returns how many items went. */
export async function purgeExpired(now = Date.now()): Promise<number> {
  const cutoff = now - TMDB_LIMIT_DAYS * DAY_MS;
  const [rows] = await exec<{ n: number }>('SELECT COUNT(*) AS n FROM cache.tmdb_title WHERE fetched_at < ?', [cutoff]);
  const [ids] = await exec<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM title WHERE tmdb_checked_at < ?) + (SELECT COUNT(*) FROM pool_seed WHERE tmdb_checked_at < ?)
          + (SELECT COUNT(*) FROM cache.import_match WHERE fetched_at < ?) AS n`,
    [cutoff, cutoff, cutoff],
  );
  if (rows.n === 0 && ids.n === 0) return 0;
  await exec('DELETE FROM cache.tmdb_title WHERE fetched_at < ?', [cutoff]);
  // The household keeps the title's name and year; the TMDB link is dropped
  // and found again from the IMDb id at the next refresh.
  await exec('UPDATE title SET tmdb_id = NULL, tmdb_checked_at = NULL WHERE tmdb_checked_at < ?', [cutoff]);
  // Recommendations keep their name and year; phase 2 matches them again.
  await exec('UPDATE pool_seed SET tmdb_id = NULL, tmdb_checked_at = NULL WHERE tmdb_checked_at < ?', [cutoff]);
  await exec('DELETE FROM cache.import_match WHERE fetched_at < ?', [cutoff]);
  changed();
  return rows.n + ids.n;
}

// ------------------------------------------------------------- one title

interface WorkRow {
  id: string;
  kind: Kind;
  name: string;
  year: number | null;
  tmdb_id: number | null;
  imdb_id: string | null;
  tmdb_data: string | null;
  tmdb_at: number | null;
  omdb_at: number | null;
  tmdb_retry: number | null;
  omdb_retry: number | null;
}

const WORK_SQL = `
  SELECT t.id, t.kind, t.name, t.year, t.tmdb_id, t.imdb_id,
         c.data AS tmdb_data, c.fetched_at AS tmdb_at, o.fetched_at AS omdb_at,
         ft.retry_after AS tmdb_retry, fo.retry_after AS omdb_retry
    FROM title t
    LEFT JOIN cache.tmdb_title c ON c.key = t.kind || ':' || t.tmdb_id
    LEFT JOIN cache.omdb_rating o ON o.imdb_id = t.imdb_id
    LEFT JOIN cache.fetch_failure ft ON ft.source = 'tmdb' AND ft.key = t.id
    LEFT JOIN cache.fetch_failure fo ON fo.source = 'omdb' AND fo.key = t.imdb_id`;

function tmdbIsStale(row: WorkRow, now: number): boolean {
  if (row.tmdb_id == null) return false;
  if (!row.tmdb_data) return true;
  return isStale(row.tmdb_at, tmdbMaxAgeDays(JSON.parse(row.tmdb_data) as TmdbTitle, now), now);
}

async function refreshTmdb(row: WorkRow): Promise<{ imdbId: string | null; relinked: boolean }> {
  const key = app.tmdbKey;
  if (row.tmdb_id == null) {
    // The TMDB link was dropped at the six-month limit; find it again.
    if (!row.imdb_id) return { imdbId: null, relinked: false };
    const ref = await findByImdb(key, row.imdb_id);
    if (!ref) return { imdbId: row.imdb_id, relinked: false };
    const details = await fetchDetails(key, ref.kind, ref.tmdbId, app.region);
    await saveTmdb(details, app.region);
    const id = await linkTitle(row.id, ref.kind, ref.tmdbId, row.name, row.year);
    await markTmdbChecked(id, details.imdbId);
    return { imdbId: details.imdbId ?? row.imdb_id, relinked: true };
  }
  const details = await fetchDetails(key, row.kind, row.tmdb_id, app.region);
  await saveTmdb(details, app.region);
  await markTmdbChecked(row.id, details.imdbId);
  return { imdbId: row.imdb_id ?? details.imdbId, relinked: false };
}

/**
 * Brings one title's data up to date: used when a title is added or opened.
 * Errors are recorded and rethrown so the screen can say what happened.
 */
export async function refreshTitle(id: string, options: { force?: boolean } = {}): Promise<void> {
  if (!app.tmdbKey) throw new ServiceError('TMDB', 0, 'No TMDB key. Add one in Settings.');
  const [row] = await exec<WorkRow>(`${WORK_SQL} WHERE t.id = ?`, [id]);
  if (!row) return;
  const now = Date.now();

  let imdbId = row.imdb_id;
  if (options.force || tmdbIsStale(row, now) || (row.tmdb_id == null && row.imdb_id)) {
    try {
      imdbId = (await refreshTmdb(row)).imdbId;
      await clearFailure('tmdb', row.id);
    } catch (error) {
      await recordFailure('tmdb', row.id, error);
      throw error;
    } finally {
      changed();
    }
  }

  if (imdbId && app.omdbKey) {
    const omdbAt = imdbId === row.imdb_id ? row.omdb_at : null;
    if (options.force || isStale(omdbAt, omdbMaxAgeDays(row.year, now), now)) {
      try {
        await saveOmdb(imdbId, await fetchOmdb(app.omdbKey, imdbId));
        await clearFailure('omdb', imdbId);
      } catch (error) {
        await recordFailure('omdb', imdbId, error);
        throw error;
      } finally {
        changed();
      }
    }
  }
}

// ------------------------------------------------------------ whole library

let running: Promise<RefreshSummary> | undefined;

/** Refreshes everything that is due. Only one refresh runs at a time. */
export function refreshAll(onProgress: (text: string) => void = () => {}): Promise<RefreshSummary> {
  running ??= runRefresh(onProgress).finally(() => {
    running = undefined;
  });
  return running;
}

async function runRefresh(onProgress: (text: string) => void): Promise<RefreshSummary> {
  const summary: RefreshSummary = { tmdb: 0, omdb: 0, relinked: 0, posters: 0, purged: 0, failures: 0, stoppedBecause: '' };
  summary.purged = await purgeExpired();

  if (!(await checkNetwork())) {
    summary.stoppedBecause = 'No network.';
    return summary;
  }
  if (!app.tmdbKey) {
    summary.stoppedBecause = 'No TMDB key.';
    return summary;
  }

  const now = Date.now();
  const rows = await exec<WorkRow>(WORK_SQL);
  const due = (retry: number | null) => retry == null || retry <= now;

  const tmdbWork = rows
    .filter((row) => due(row.tmdb_retry) && (tmdbIsStale(row, now) || (row.tmdb_id == null && row.imdb_id)))
    .sort((a, b) => (a.tmdb_at ?? 0) - (b.tmdb_at ?? 0))
    .slice(0, 400);

  for (const [index, row] of tmdbWork.entries()) {
    onProgress(`Updating title details: ${index + 1} of ${tmdbWork.length}`);
    try {
      const result = await refreshTmdb(row);
      await clearFailure('tmdb', row.id);
      summary.tmdb++;
      if (result.relinked) summary.relinked++;
      if (result.imdbId && !row.imdb_id) row.imdb_id = result.imdbId;
    } catch (error) {
      summary.failures++;
      await recordFailure('tmdb', row.id, error);
      if (error instanceof ServiceError && (error.status === 401 || error.status === 429)) {
        summary.stoppedBecause = error.message;
        break;
      }
    }
  }
  if (summary.tmdb > 0) changed();

  if (app.omdbKey && !summary.stoppedBecause) {
    const fresh = await exec<WorkRow>(WORK_SQL);
    const omdbWork = fresh
      .filter((row) => row.imdb_id && due(row.omdb_retry) && isStale(row.omdb_at, omdbMaxAgeDays(row.year, now), now))
      .sort((a, b) => (a.omdb_at ?? 0) - (b.omdb_at ?? 0))
      .slice(0, await omdbRemainingToday());
    for (const [index, row] of omdbWork.entries()) {
      onProgress(`Updating review scores: ${index + 1} of ${omdbWork.length}`);
      const imdbId = row.imdb_id as string;
      try {
        await saveOmdb(imdbId, await fetchOmdb(app.omdbKey, imdbId));
        await clearFailure('omdb', imdbId);
        summary.omdb++;
      } catch (error) {
        summary.failures++;
        await recordFailure('omdb', imdbId, error);
        if (error instanceof ServiceError && (error.status === 401 || error.status === 429)) break;
      }
    }
    if (summary.omdb > 0) changed();
  }

  onProgress('Saving posters for offline use');
  const posters = await exec<{ path: string }>(
    `SELECT json_extract(c.data, '$.posterPath') AS path
       FROM title t JOIN cache.tmdb_title c ON c.key = t.kind || ':' || t.tmdb_id
      WHERE json_extract(c.data, '$.posterPath') IS NOT NULL`,
  );
  summary.posters = await prefetchPosters(posters.map((row) => row.path));

  await setGatewayState('last_refresh_at', String(Date.now()));
  onProgress('');
  return summary;
}

/** Runs the refresh at most once a day, when there is something to fetch with. */
export async function refreshIfDue(onProgress: (text: string) => void): Promise<RefreshSummary | undefined> {
  const last = Number((await getGatewayState('last_refresh_at')) ?? 0);
  if (Date.now() - last < DAY_MS) {
    await purgeExpired();
    return undefined;
  }
  return refreshAll(onProgress);
}

export async function lastRefreshAt(): Promise<number | null> {
  const value = await getGatewayState('last_refresh_at');
  return value ? Number(value) : null;
}
