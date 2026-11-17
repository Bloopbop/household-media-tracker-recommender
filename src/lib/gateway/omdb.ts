// OMDb adapter: IMDb, Rotten Tomatoes and Metacritic scores, one title per
// request, within a daily budget kept below the free key's 1,000 a day.

import { getGatewayState, setGatewayState } from '../db';
import type { OmdbScores } from '../types';
import { Limiter } from './limiter';
import { ServiceError } from './tmdb';

export const OMDB_DAILY_BUDGET = 800;
const omdbLimiter = new Limiter(250, 1);

type Raw = Record<string, unknown>;

const score = (text: unknown, pattern: RegExp): number | null => {
  const match = typeof text === 'string' ? pattern.exec(text) : null;
  return match ? Number(match[1]) : null;
};

export function normalizeOmdb(raw: Raw): OmdbScores {
  const ratings = Array.isArray(raw.Ratings) ? (raw.Ratings as Raw[]) : [];
  const source = (name: string) => ratings.find((rating) => rating.Source === name)?.Value;
  const votes = typeof raw.imdbVotes === 'string' ? Number(raw.imdbVotes.replace(/,/g, '')) : NaN;
  return {
    imdbRating: score(raw.imdbRating, /^(\d+(?:\.\d+)?)$/) ?? score(source('Internet Movie Database'), /^(\d+(?:\.\d+)?)\//),
    imdbVotes: Number.isFinite(votes) ? votes : null,
    rottenTomatoes: score(source('Rotten Tomatoes'), /^(\d+)%$/),
    metacritic: score(raw.Metascore, /^(\d+)$/) ?? score(source('Metacritic'), /^(\d+)\//),
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export async function omdbRemainingToday(): Promise<number> {
  if ((await getGatewayState('omdb_day')) !== today()) return OMDB_DAILY_BUDGET;
  return Math.max(0, OMDB_DAILY_BUDGET - Number((await getGatewayState('omdb_count')) ?? 0));
}

async function countRequest(): Promise<void> {
  const day = today();
  const count = (await getGatewayState('omdb_day')) === day ? Number((await getGatewayState('omdb_count')) ?? 0) : 0;
  await setGatewayState('omdb_day', day);
  await setGatewayState('omdb_count', String(count + 1));
}

async function exhaustToday(): Promise<void> {
  await setGatewayState('omdb_day', today());
  await setGatewayState('omdb_count', String(OMDB_DAILY_BUDGET));
}

/** Returns null when OMDb has no record of the title. */
export async function fetchOmdb(key: string, imdbId: string): Promise<OmdbScores | null> {
  if (!key) throw new ServiceError('OMDb', 0, 'No OMDb key. Add one in Settings.');
  if ((await omdbRemainingToday()) <= 0) throw new ServiceError('OMDb', 429, "Today's OMDb allowance is used up.");

  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('i', imdbId);
  url.searchParams.set('apikey', key);
  await countRequest();
  const response = await omdbLimiter.run(() => fetch(url));
  const data = (await response.json().catch(() => ({}))) as Raw;

  if (data.Response === 'True') return normalizeOmdb(data);
  const error = typeof data.Error === 'string' ? data.Error : `HTTP ${response.status}`;
  if (/limit/i.test(error)) {
    await exhaustToday();
    throw new ServiceError('OMDb', 429, "Today's OMDb allowance is used up.");
  }
  if (/not found|incorrect imdb/i.test(error)) return null;
  if (response.status === 401 || /invalid api key/i.test(error)) throw new ServiceError('OMDb', 401, 'OMDb rejected the key. Check it in Settings.');
  throw new ServiceError('OMDb', response.status, `OMDb: ${error}`);
}
