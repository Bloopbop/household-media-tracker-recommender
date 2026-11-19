// The recommender's background work: rebuild slates when their data changes,
// and, when online, keep the candidate pool gathered and detailed, with
// review scores for the best candidates. Started at launch after the daily
// refresh; one run at a time; resumes from the data at the next launch.

import { setGatewayState } from '../db';
import { buildPool, fillPool, poolIsDue } from '../gateway/pool';
import { prefetchPosters } from '../gateway/posters';
import { fetchWantedOmdb } from '../gateway/refresh';
import { app } from '../state.svelte';
import { loadRecInput } from './data';
import { buildSlates, TOP_CANDIDATES } from './engine';
import { dataFingerprint, latestFingerprint, saveOmdbWanted, saveSlates, slatesBuiltToday } from './store';
import type { SlateResult } from './types';

/** Merges each mode's best candidates in turn, so all three get review scores. */
export function mergeTop(results: SlateResult[], count = TOP_CANDIDATES): string[] {
  const merged = new Set<string>();
  const longest = Math.max(0, ...results.map((result) => result.stats.topCandidates.length));
  for (let index = 0; index < longest && merged.size < count; index++) {
    for (const result of results) {
      const key = result.stats.topCandidates[index];
      if (key) merged.add(key);
    }
  }
  return [...merged].slice(0, count);
}

async function rebuild(force: boolean): Promise<boolean> {
  const fingerprint = await dataFingerprint(app.region);
  // Rebuilt when the data changed, and once a day: the new day's slate takes
  // in yesterday's reactions and gets a new mix of the two rankings.
  if (!force && fingerprint === (await latestFingerprint()) && (await slatesBuiltToday())) return false;
  const started = performance.now();
  const input = await loadRecInput();
  if (input.features.size === 0) return false;
  const results = buildSlates(input);
  const buildMs = Math.round(performance.now() - started);
  await saveSlates(results, fingerprint, buildMs);
  await saveOmdbWanted(mergeTop(results));
  app.lastSlateBuildMs = buildMs;
  app.slatesVersion++;
  if (app.online) {
    const posters = results.flatMap((result) => [...result.picks, ...result.reserve]).map((pick) => pick.posterPath);
    void prefetchPosters(posters.filter((path): path is string => Boolean(path)), 150).catch(() => 0);
  }
  return true;
}

let rebuilding: Promise<boolean> | undefined;

/** Rebuilds the three slates if anything they depend on changed. Resolves to whether it did. */
export function refreshSlates(force = false): Promise<boolean> {
  rebuilding ??= rebuild(force).finally(() => (rebuilding = undefined));
  return rebuilding;
}

async function work(): Promise<void> {
  await refreshSlates();
  if (!app.online || !app.tmdbKey) return;
  const status = (text: string) => (app.recStatus = text);
  if (await poolIsDue()) {
    status('Looking for candidates…');
    await buildPool(status);
  }
  const fill = await fillPool(status, async () => {
    await refreshSlates();
  });
  if (fill.fetched > 0) await refreshSlates();
  if ((await fetchWantedOmdb(status)) > 0) await refreshSlates();
}

let running: Promise<void> | undefined;

export function runRecJob(): Promise<void> {
  running ??= work()
    .then(() => {
      app.recError = '';
    })
    .catch((error: unknown) => {
      app.recError = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      app.recStatus = '';
      running = undefined;
    });
  return running;
}

/** Gathers the pool again at the next run (after the services or country change). */
export async function markPoolDue(): Promise<void> {
  await setGatewayState('pool_built_at', '0');
}
