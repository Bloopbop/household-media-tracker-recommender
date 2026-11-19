// The candidate pool (spec, section 3, pipeline step 1): up to 3,000 titles
// the household has not seen, rebuilt weekly from
//   - TMDB's recommendation and similar lists of the 200 most recent liked titles,
//   - /discover on each profile's top 5 genres, 10 keywords and 10 people (200+ votes),
//   - titles on the household's streaming services,
//   - this week's trending titles, and popular titles,
//   - the vault's recommendations (pool_seed).
// Watchlists and would-rewatch titles are library titles, so the recommender
// adds them itself. Every candidate then needs its TMDB details, fetched in
// the background and resumed at each launch.

import { batch, exec, getGatewayState, setGatewayState } from '../db';
import { checkNetwork } from '../network';
import { keyOf } from '../rec/features';
import { buildProfile } from '../rec/profile';
import { loadRecInput, getServices } from '../rec/data';
import { isNeutral, MODES } from '../rec/types';
import { VectorSpace } from '../rec/vectors';
import { app } from '../state.svelte';
import { TMDB_SHAPE_VERSION, type Kind, type SearchResult } from '../types';
import { DAY_MS } from './policy';
import { clearFailure, recordFailure, saveTmdb } from './refresh';
import { discoverTitles, fetchDetails, ServiceError, trendingTitles, watchProviderList, type RegionProvider } from './tmdb';

export const POOL_MAX = 3000;
export const POOL_REFRESH_DAYS = 7;
const LIKED_LISTS = 200;
const MIN_VOTES = 200;
/** Pages of popular movies and of popular series (20 titles a page). */
const POPULAR_PAGES = 5;

/** TMDB's genre ids that exist for movies, and for series (they differ for a few genres). */
const MOVIE_GENRES = new Set([28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]);
const SERIES_GENRES = new Set([10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37]);

export interface PoolQuery {
  kind: Kind;
  params: Record<string, string | number>;
}

/** The /discover queries for a profile's strongest genres, keywords and people. Pure, unit tested. */
export function discoverQueries(centroid: Float64Array, tokens: string[]): PoolQuery[] {
  const top = (test: (token: string) => boolean, count: number) =>
    tokens
      .map((token, col) => ({ token, weight: centroid[col] }))
      .filter((entry) => entry.weight > 0 && test(entry.token))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, count)
      .map((entry) => Number(entry.token.slice(2)));
  const base = { sort_by: 'vote_average.desc', 'vote_count.gte': MIN_VOTES };
  const queries: PoolQuery[] = [];
  for (const genre of top((token) => token.startsWith('g:'), 5)) {
    if (MOVIE_GENRES.has(genre)) queries.push({ kind: 'movie', params: { ...base, with_genres: genre } });
    if (SERIES_GENRES.has(genre)) queries.push({ kind: 'series', params: { ...base, with_genres: genre } });
  }
  for (const keyword of top((token) => token.startsWith('k:'), 10)) {
    queries.push({ kind: 'movie', params: { ...base, with_keywords: keyword } });
    queries.push({ kind: 'series', params: { ...base, with_keywords: keyword } });
  }
  // TMDB can search movies by person, but not series.
  for (const person of top((token) => /^[dcw]:/.test(token), 10)) {
    queries.push({ kind: 'movie', params: { ...base, with_people: person } });
  }
  return queries;
}

const queryKey = (query: PoolQuery) => `${query.kind}?${new URLSearchParams(Object.entries(query.params).map(([k, v]) => [k, String(v)]))}`;

export interface PoolBuild {
  size: number;
  calls: number;
  /** List requests that failed and were skipped. */
  failed: number;
}

/** Rebuilds the pool's list of candidates (not their details). */
export async function buildPool(onProgress: (text: string) => void = () => {}): Promise<PoolBuild> {
  const key = app.tmdbKey;
  const input = await loadRecInput();
  const space = new VectorSpace(input.features.values());
  const found = new Map<string, { kind: Kind; tmdbId: number; sources: Set<string>; rank: number }>();
  const add = (kind: Kind, tmdbId: number, source: string, rank: number) => {
    const id = keyOf(kind, tmdbId);
    const entry = found.get(id) ?? { kind, tmdbId, sources: new Set<string>(), rank: Infinity };
    entry.sources.add(source);
    entry.rank = Math.min(entry.rank, rank);
    found.set(id, entry);
  };
  const addResults = (results: SearchResult[], source: string, base: number) =>
    results.forEach((result, index) => add(result.kind, result.tmdbId, source, base + index / 100));

  // The vault's recommendations come first.
  const seeds = await exec<{ kind: Kind; tmdb_id: number }>('SELECT kind, tmdb_id FROM pool_seed WHERE tmdb_id IS NOT NULL');
  for (const seed of seeds) add(seed.kind, seed.tmdb_id, 'vault', 0);

  // Lists of the most recently liked titles, from any rater; and each profile's discover queries.
  const liked = new Map<string, number>();
  const queries = new Map<string, PoolQuery>();
  for (const mode of MODES) {
    const profile = buildProfile(input.library, mode, space, input.now);
    for (const entry of profile.liked) liked.set(entry.key, Math.max(liked.get(entry.key) ?? 0, entry.at));
    for (const query of discoverQueries(profile.centroid, space.tokens)) queries.set(queryKey(query), query);
  }
  const recent = [...liked.entries()].sort((a, b) => b[1] - a[1]).slice(0, LIKED_LISTS);
  for (const [likedKey] of recent) {
    const feature = input.features.get(likedKey);
    feature?.recs.forEach((rec, index) => {
      const [kind, id] = rec.split(':');
      add(kind as Kind, Number(id), 'recommended', 1 + index / 100);
    });
    feature?.sims.forEach((sim, index) => {
      const [kind, id] = sim.split(':');
      add(kind as Kind, Number(id), 'similar', 2 + index / 100);
    });
  }

  let calls = 0;
  let failed = 0;
  /** One list request. A refused key or a slow-down stops the build; anything else skips that list. */
  const listed = async (request: () => Promise<SearchResult[]>): Promise<SearchResult[]> => {
    calls++;
    try {
      return await request();
    } catch (error) {
      if (error instanceof ServiceError && (error.status === 401 || error.status === 429)) throw error;
      if (!(error instanceof ServiceError) && !(await checkNetwork())) throw error;
      failed++;
      return [];
    }
  };

  const list = [...queries.values()];
  for (const [index, query] of list.entries()) {
    onProgress(`Looking for candidates: search ${index + 1} of ${list.length}`);
    addResults(await listed(() => discoverTitles(key, query.kind, query.params)), 'discover', 3);
  }

  const services = await getServices(app.region);
  if (services && services.length) {
    for (const kind of ['movie', 'series'] as Kind[]) {
      for (const page of [1, 2]) {
        const results = await listed(() =>
          discoverTitles(key, kind, {
            with_watch_providers: services.join('|'),
            watch_region: app.region,
            sort_by: 'popularity.desc',
            'vote_count.gte': MIN_VOTES,
            page,
          }),
        );
        addResults(results, 'services', 4 + (page - 1) * 0.2);
      }
    }
  }

  addResults(await listed(() => trendingTitles(key)), 'trending', 5);

  // Popular titles, chosen without the household's taste: they keep the pool
  // from being only look-alikes, and give the recommendation check a fair
  // set of titles to rank the household's favourites against.
  for (const kind of ['movie', 'series'] as Kind[]) {
    for (let page = 1; page <= POPULAR_PAGES; page++) {
      const results = await listed(() => discoverTitles(key, kind, { sort_by: 'popularity.desc', 'vote_count.gte': MIN_VOTES, page }));
      addResults(results, 'popular', 6 + (page - 1) * 0.2);
    }
  }

  const chosen = capPool(found);
  const now = Date.now();
  await batch([
    { sql: 'DELETE FROM cache.pool' },
    ...chosen.map(([id, entry]) => ({
      sql: 'INSERT INTO cache.pool (key, kind, tmdb_id, sources, rank, listed_at) VALUES (?, ?, ?, ?, ?, ?)',
      bind: [id, entry.kind, entry.tmdbId, JSON.stringify([...entry.sources]), entry.rank, now],
    })),
    // Records of titles that left the pool, and are not the household's, go now rather than at six months.
    {
      sql: `DELETE FROM cache.tmdb_title
             WHERE key NOT IN (SELECT key FROM cache.pool)
               AND key NOT IN (SELECT kind || ':' || tmdb_id FROM title WHERE tmdb_id IS NOT NULL)
               AND key NOT IN (SELECT kind || ':' || tmdb_id FROM pool_seed WHERE tmdb_id IS NOT NULL)`,
    },
    { sql: 'DELETE FROM cache.title_feature WHERE key NOT IN (SELECT key FROM cache.tmdb_title)' },
  ]);
  await setGatewayState('pool_built_at', String(now));
  await setGatewayState('pool_version', String(POOL_VERSION));
  return { size: chosen.length, calls, failed };
}

export async function poolBuiltAt(): Promise<number | null> {
  const value = await getGatewayState('pool_built_at');
  return value ? Number(value) : null;
}

/**
 * Bump when the pool's sources change, so the next run gathers it again.
 * 2 added popular titles; 3 keeps every taste-neutral title under the cap and
 * takes five pages of popular titles of each kind.
 */
export const POOL_VERSION = 3;

/**
 * The titles to keep, at most `max`, in rank order. Every title from a
 * taste-neutral source stays (a few hundred at most), so the recommendation
 * check always has titles chosen without the household's taste; the rest
 * fill the remaining places by rank. Pure, unit tested.
 */
export function capPool<T extends { sources: Set<string>; rank: number }>(found: Map<string, T>, max = POOL_MAX): [string, T][] {
  const ordered = [...found.entries()].sort((a, b) => a[1].rank - b[1].rank || b[1].sources.size - a[1].sources.size);
  const neutral = ordered.filter(([, entry]) => isNeutral([...entry.sources])).slice(0, max);
  const kept = new Set(neutral.map(([id]) => id));
  for (const [id] of ordered) {
    if (kept.size >= max) break;
    kept.add(id);
  }
  return ordered.filter(([id]) => kept.has(id));
}

export async function poolIsDue(now = Date.now()): Promise<boolean> {
  const built = await poolBuiltAt();
  if (Number((await getGatewayState('pool_version')) ?? 1) < POOL_VERSION) return true;
  return built == null || now - built >= POOL_REFRESH_DAYS * DAY_MS;
}

export interface PoolFill {
  fetched: number;
  failures: number;
  remaining: number;
  stoppedBecause: string;
}

/** Pool titles whose TMDB details are missing, in an older shape, for another country, or stale. */
export async function poolNeedingDetails(now = Date.now()): Promise<{ key: string; kind: Kind; tmdb_id: number }[]> {
  const thisYear = new Date(now).getUTCFullYear();
  return exec<{ key: string; kind: Kind; tmdb_id: number }>(
    `SELECT p.key, p.kind, p.tmdb_id FROM cache.pool p
       LEFT JOIN cache.tmdb_title c ON c.key = p.key
       LEFT JOIN cache.fetch_failure f ON f.source = 'pool' AND f.key = p.key
      WHERE (c.key IS NULL
             OR IFNULL(json_extract(c.data, '$.version'), 1) < ?
             OR IFNULL(c.region, '') <> ?
             OR c.fetched_at < CASE WHEN IFNULL(json_extract(c.data, '$.year'), 0) >= ? THEN ? ELSE ? END)
        AND (f.retry_after IS NULL OR f.retry_after <= ?)
      ORDER BY p.rank`,
    [TMDB_SHAPE_VERSION, app.region, thisYear - 1, now - 7 * DAY_MS, now - 30 * DAY_MS, now],
  );
}

/**
 * Fetches TMDB details for pool titles that need them. Resumable: what is
 * left is worked out from the data each time. onBatch runs every `every`
 * titles so slates can improve while this runs.
 */
export async function fillPool(
  onProgress: (text: string) => void = () => {},
  onBatch: () => Promise<void> = async () => {},
  every = 400,
): Promise<PoolFill> {
  const work = await poolNeedingDetails();
  const result: PoolFill = { fetched: 0, failures: 0, remaining: work.length, stoppedBecause: '' };
  for (const [index, row] of work.entries()) {
    if (!app.online || !app.tmdbKey) {
      result.stoppedBecause = app.online ? 'No TMDB key.' : 'No network.';
      break;
    }
    onProgress(`Finding candidates: ${index + 1} of ${work.length}`);
    try {
      await saveTmdb(await fetchDetails(app.tmdbKey, row.kind, row.tmdb_id, app.region), app.region);
      await clearFailure('pool', row.key);
      result.fetched++;
    } catch (error) {
      // A dropped connection is not the title's fault: stop, and carry on next time.
      if (!(error instanceof ServiceError) && !(await checkNetwork())) {
        app.online = false;
        result.stoppedBecause = 'No network.';
        break;
      }
      result.failures++;
      await recordFailure('pool', row.key, error);
      if (error instanceof ServiceError && (error.status === 401 || error.status === 429)) {
        result.stoppedBecause = error.message;
        break;
      }
    }
    result.remaining = work.length - index - 1;
    if (result.fetched > 0 && result.fetched % every === 0) await onBatch();
  }
  return result;
}

// --------------------------------------------------------------- services

/** The region's services, as last fetched; empty if never fetched. */
export async function cachedProviders(region: string): Promise<RegionProvider[]> {
  const rows = await exec<{ id: number; name: string; logo_path: string | null; priority: number }>(
    'SELECT id, name, logo_path, priority FROM cache.provider WHERE region = ? ORDER BY priority, name',
    [region],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, logoPath: row.logo_path, priority: row.priority }));
}

/** Fetches the region's services from TMDB and stores them. */
export async function fetchProviders(region: string): Promise<RegionProvider[]> {
  const providers = await watchProviderList(app.tmdbKey, region);
  const now = Date.now();
  await batch([
    { sql: 'DELETE FROM cache.provider WHERE region = ?', bind: [region] },
    ...providers.map((provider) => ({
      sql: 'INSERT INTO cache.provider (region, id, name, logo_path, priority, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
      bind: [region, provider.id, provider.name, provider.logoPath, provider.priority, now],
    })),
  ]);
  return providers;
}

