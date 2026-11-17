// Gateway tests use hand-written sample responses shaped like the services'
// documented formats. No live service data is stored in this repository.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TmdbTitle } from '../types';
import { Limiter, MAX_BACKOFF_MS, retryAfterMs } from './limiter';
import { normalizeOmdb } from './omdb';
import { DAY_MS, isStale, omdbMaxAgeDays, retryDelayMs, tmdbMaxAgeDays } from './policy';
import { normalizeMovie, normalizeSearchResult, normalizeSeries } from './tmdb';

const sampleMovie = {
  id: 101,
  title: 'Sample Film',
  original_title: 'Film Exemple',
  release_date: '2004-03-19',
  overview: 'A made-up film for tests.',
  poster_path: '/sample-film.jpg',
  runtime: 108,
  genres: [{ id: 1, name: 'Drama' }, { id: 2, name: 'Romance' }],
  vote_average: 8.1,
  vote_count: 1234,
  original_language: 'fr',
  production_countries: [{ iso_3166_1: 'FR' }],
  imdb_id: 'tt0000101',
  status: 'Released',
  credits: {
    cast: [
      { name: 'Second Billed', character: 'B', order: 1 },
      { name: 'Top Billed', character: 'A', order: 0 },
    ],
    crew: [
      { name: 'Dee Rector', job: 'Director' },
      { name: 'Dee Rector', job: 'Director' },
      { name: 'Ray Writer', job: 'Screenplay' },
      { name: 'Ed Itor', job: 'Editor' },
    ],
  },
  keywords: { keywords: [{ name: 'memory' }, { name: 'love' }] },
  external_ids: { imdb_id: 'tt0000101' },
  recommendations: { results: [{ id: 7, media_type: 'movie' }, { id: 8, media_type: 'tv' }] },
  similar: { results: [{ id: 9 }] },
  'watch/providers': {
    results: {
      CA: {
        flatrate: [{ provider_id: 8, provider_name: 'Stream Co', logo_path: '/s.png' }],
        rent: [{ provider_id: 2, provider_name: 'Rent Co', logo_path: null }],
      },
      US: { buy: [{ provider_id: 3, provider_name: 'Buy Co' }] },
    },
  },
};

const sampleSeries = {
  id: 202,
  name: 'Sample Show',
  original_name: 'Sample Show',
  first_air_date: '2002-06-02',
  last_air_date: '2008-03-09',
  overview: 'A made-up series.',
  poster_path: null,
  episode_run_time: [],
  genres: [{ name: 'Crime' }],
  vote_average: 8.6,
  vote_count: 999,
  original_language: 'en',
  origin_country: ['US'],
  created_by: [{ name: 'Cree Ator' }],
  status: 'Ended',
  number_of_seasons: 5,
  number_of_episodes: 60,
  credits: { cast: [] },
  keywords: { results: [{ name: 'city' }] },
  external_ids: { imdb_id: 'tt0000202' },
  recommendations: { results: [] },
  similar: { results: [{ id: 5, media_type: 'tv' }] },
  'watch/providers': { results: {} },
};

describe('TMDB normalizing', () => {
  it('keeps the movie fields the app uses, for the household region only', () => {
    const movie = normalizeMovie(sampleMovie, 'CA');
    expect(movie).toMatchObject({
      kind: 'movie',
      tmdbId: 101,
      name: 'Sample Film',
      year: 2004,
      runtime: 108,
      genres: ['Drama', 'Romance'],
      directors: ['Dee Rector'],
      writers: ['Ray Writer'],
      keywords: ['memory', 'love'],
      imdbId: 'tt0000101',
      countries: ['FR'],
    });
    expect(movie.cast.map((person) => person.name)).toEqual(['Top Billed', 'Second Billed']);
    expect(movie.recommendations).toEqual([
      { kind: 'movie', tmdbId: 7 },
      { kind: 'series', tmdbId: 8 },
    ]);
    expect(movie.similar).toEqual([{ kind: 'movie', tmdbId: 9 }]);
    expect(movie.availability).toEqual({
      region: 'CA',
      stream: [{ id: 8, name: 'Stream Co', logoPath: '/s.png' }],
      free: [],
      ads: [],
      rent: [{ id: 2, name: 'Rent Co', logoPath: null }],
      buy: [],
    });
    expect(normalizeMovie(sampleMovie, 'GB').availability).toBeNull();
  });

  it('keeps the series fields, with an end year once it has ended', () => {
    const series = normalizeSeries(sampleSeries, 'CA');
    expect(series).toMatchObject({
      kind: 'series',
      tmdbId: 202,
      year: 2002,
      endYear: 2008,
      runtime: null,
      posterPath: null,
      directors: ['Cree Ator'],
      keywords: ['city'],
      imdbId: 'tt0000202',
      seasons: 5,
      availability: null,
    });
    expect(normalizeSeries({ ...sampleSeries, status: 'Returning Series' }, 'CA').endYear).toBeNull();
  });

  it('survives missing and malformed fields', () => {
    const empty = normalizeMovie({ id: 5, genres: 'not a list', credits: null }, 'CA');
    expect(empty).toMatchObject({ tmdbId: 5, name: '', year: null, genres: [], cast: [], availability: null });
  });

  it('turns search results into movies and series, dropping people', () => {
    expect(normalizeSearchResult({ media_type: 'tv', id: 3, name: 'Show', first_air_date: '2019-01-01' })).toMatchObject({
      kind: 'series',
      name: 'Show',
      year: 2019,
    });
    expect(normalizeSearchResult({ media_type: 'person', id: 4, name: 'Someone' })).toBeNull();
    expect(normalizeSearchResult({ id: 6, title: 'Film' }, 'movie')).toMatchObject({ kind: 'movie', name: 'Film', year: null });
  });
});

describe('OMDb normalizing', () => {
  it('reads all three scores', () => {
    expect(
      normalizeOmdb({
        imdbRating: '8.3',
        imdbVotes: '1,234,567',
        Metascore: '74',
        Ratings: [
          { Source: 'Internet Movie Database', Value: '8.3/10' },
          { Source: 'Rotten Tomatoes', Value: '93%' },
          { Source: 'Metacritic', Value: '74/100' },
        ],
      }),
    ).toEqual({ imdbRating: 8.3, imdbVotes: 1234567, rottenTomatoes: 93, metacritic: 74 });
  });

  it('treats N/A as missing', () => {
    expect(normalizeOmdb({ imdbRating: 'N/A', imdbVotes: 'N/A', Metascore: 'N/A', Ratings: [] })).toEqual({
      imdbRating: null,
      imdbVotes: null,
      rottenTomatoes: null,
      metacritic: null,
    });
  });
});

describe('refresh policy', () => {
  const now = Date.UTC(2026, 10, 17);
  const base = normalizeMovie(sampleMovie, 'CA');

  it('refreshes recent and airing titles weekly, others monthly', () => {
    expect(tmdbMaxAgeDays({ ...base, firstAirDate: '2026-06-01' } as TmdbTitle, now)).toBe(7);
    expect(tmdbMaxAgeDays(base, now)).toBe(30);
    expect(tmdbMaxAgeDays({ ...normalizeSeries(sampleSeries, 'CA'), status: 'Returning Series' }, now)).toBe(7);
    expect(tmdbMaxAgeDays({ ...base, firstAirDate: '2027-02-01' } as TmdbTitle, now)).toBe(7);
  });

  it('refreshes review scores monthly for new titles, twice a year otherwise', () => {
    expect(omdbMaxAgeDays(2026, now)).toBe(30);
    expect(omdbMaxAgeDays(2025, now)).toBe(30);
    expect(omdbMaxAgeDays(2010, now)).toBe(180);
    expect(omdbMaxAgeDays(null, now)).toBe(180);
  });

  it('treats missing data as stale', () => {
    expect(isStale(null, 30, now)).toBe(true);
    expect(isStale(now - 29 * DAY_MS, 30, now)).toBe(false);
    expect(isStale(now - 30 * DAY_MS, 30, now)).toBe(true);
  });

  it('backs off failed fetches from an hour to a week', () => {
    expect(retryDelayMs(1)).toBe(3_600_000);
    expect(retryDelayMs(3)).toBe(4 * 3_600_000);
    expect(retryDelayMs(20)).toBe(7 * DAY_MS);
  });
});

describe('limiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spaces request starts and caps requests in flight', async () => {
    const limiter = new Limiter(250, 2, () => Date.now());
    const started: number[] = [];
    const t0 = Date.now();
    const finishers: Array<() => void> = [];
    const tasks = [0, 1, 2].map(() =>
      limiter.run(
        () =>
          new Promise<void>((resolve) => {
            started.push(Date.now() - t0);
            finishers.push(resolve);
          }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toEqual([0, 250]);
    finishers[0]();
    await vi.advanceTimersByTimeAsync(10);
    expect(started.length).toBe(3);
    finishers[1]();
    finishers[2]();
    await Promise.all(tasks);
  });

  it('doubles its pause after each 429, up to 15 minutes, and honors Retry-After', () => {
    const limiter = new Limiter(250, 2, () => 0);
    expect(limiter.slowDown()).toBe(2000);
    expect(limiter.slowDown()).toBe(4000);
    expect(limiter.slowDown(60_000)).toBe(60_000);
    for (let i = 0; i < 20; i++) limiter.slowDown();
    expect(limiter.slowDown()).toBe(MAX_BACKOFF_MS);
    limiter.recovered();
    expect(limiter.slowDown()).toBe(2000);
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(null)).toBe(0);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000);
  });
});
