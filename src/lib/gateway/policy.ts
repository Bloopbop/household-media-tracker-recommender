// How long fetched data stays fresh, and when it must go. Pure, unit tested.

import type { TmdbTitle } from '../types';

export const DAY_MS = 86_400_000;

/**
 * TMDB's API terms forbid caching its data for longer than six months. Data
 * is refetched long before this; anything that reaches it unrefreshed is
 * deleted. 179 days leaves a margin under the shortest six months.
 */
export const TMDB_LIMIT_DAYS = 179;

/** Posters are cached by the service worker; it drops them sooner. */
export const POSTER_MAX_AGE_DAYS = 170;

const AIRING = new Set(['Returning Series', 'In Production', 'Planned', 'Pilot']);

/** 7 days for titles under a year old or still airing; 30 days otherwise. */
export function tmdbMaxAgeDays(title: TmdbTitle, now: number): number {
  if (title.kind === 'series' && AIRING.has(title.status)) return 7;
  const released = title.firstAirDate ? Date.parse(title.firstAirDate) : NaN;
  if (!Number.isFinite(released)) return title.year != null && title.year >= new Date(now).getUTCFullYear() - 1 ? 7 : 30;
  return now - released < 365 * DAY_MS ? 7 : 30;
}

/** 30 days for titles under two years old; 180 days otherwise. */
export function omdbMaxAgeDays(year: number | null, now: number): number {
  return year != null && year >= new Date(now).getUTCFullYear() - 1 ? 30 : 180;
}

export function isStale(fetchedAt: number | null | undefined, maxAgeDays: number, now: number): boolean {
  return fetchedAt == null || now - fetchedAt >= maxAgeDays * DAY_MS;
}

/** After a failed fetch, wait 1, 2, 4… hours before trying again, at most a week. */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 3_600_000, 7 * DAY_MS);
}
