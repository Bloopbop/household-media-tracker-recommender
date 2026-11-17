// TMDB adapter: search, details and IMDb-id lookups, trimmed to the fields the
// app uses. Read-only; the household's data is never sent.

import type { Availability, Kind, Provider, SearchResult, TitleRef, TmdbTitle } from '../types';
import { Limiter, retryAfterMs } from './limiter';

const API = 'https://api.themoviedb.org/3';
const DETAIL_SECTIONS = ['credits', 'keywords', 'external_ids', 'recommendations', 'similar', 'watch/providers'];

// The spec's client limit: 4 requests a second, 2 at a time.
export const tmdbLimiter = new Limiter(250, 2);

export class ServiceError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** TMDB issues a short v3 key and a long v4 token; either works. */
const isBearerToken = (key: string) => key.length > 60 && key.includes('.');

export async function tmdbGet<T>(key: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!key) throw new ServiceError('TMDB', 0, 'No TMDB key. Add one in Settings.');
  const url = new URL(API + path);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (isBearerToken(key)) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await tmdbLimiter.run(() => fetch(url, { headers }));
    if (response.status === 429) {
      const wait = tmdbLimiter.slowDown(retryAfterMs(response.headers.get('Retry-After')));
      if (wait > 60_000) throw new ServiceError('TMDB', 429, 'TMDB asked the app to slow down. It will try again later.');
      continue;
    }
    tmdbLimiter.recovered();
    if (response.status === 401) throw new ServiceError('TMDB', 401, 'TMDB rejected the key. Check it in Settings.');
    if (response.status === 404) throw new ServiceError('TMDB', 404, 'TMDB has no such title.');
    if (!response.ok) throw new ServiceError('TMDB', response.status, `TMDB answered with HTTP ${response.status}.`);
    return (await response.json()) as T;
  }
  throw new ServiceError('TMDB', 429, 'TMDB asked the app to slow down. It will try again later.');
}

// ------------------------------------------------------------- normalizing

type Raw = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? (value.filter((item) => item && typeof item === 'object') as Raw[]) : []);
const yearOf = (date: unknown): number | null => {
  const match = /^(\d{4})/.exec(str(date));
  return match ? Number(match[1]) : null;
};
const names = (items: Raw[], field = 'name') => items.map((item) => str(item[field])).filter(Boolean);
const unique = (values: string[]) => [...new Set(values)];

function refs(section: unknown, fallbackKind: Kind): TitleRef[] {
  return list((section as Raw | undefined)?.results)
    .map((item): TitleRef | null => {
      const id = num(item.id);
      const mediaType = str(item.media_type);
      const kind: Kind = mediaType === 'tv' ? 'series' : mediaType === 'movie' ? 'movie' : fallbackKind;
      return id == null ? null : { kind, tmdbId: id };
    })
    .filter((ref): ref is TitleRef => ref !== null);
}

function providers(items: unknown): Provider[] {
  return list(items)
    .map((item) => ({ id: num(item.provider_id) ?? 0, name: str(item.provider_name), logoPath: str(item.logo_path) || null }))
    .filter((provider) => provider.id > 0 && provider.name);
}

function availability(section: unknown, region: string): Availability | null {
  const results = (section as Raw | undefined)?.results as Raw | undefined;
  const entry = results?.[region] as Raw | undefined;
  if (!entry) return null;
  return {
    region,
    stream: providers(entry.flatrate),
    free: providers(entry.free),
    ads: providers(entry.ads),
    rent: providers(entry.rent),
    buy: providers(entry.buy),
  };
}

function cast(credits: unknown): TmdbTitle['cast'] {
  return list((credits as Raw | undefined)?.cast)
    .sort((a, b) => (num(a.order) ?? 999) - (num(b.order) ?? 999))
    .slice(0, 10)
    .map((person) => ({ name: str(person.name), character: str(person.character) }))
    .filter((person) => person.name);
}

const WRITING_JOBS = new Set(['Screenplay', 'Writer', 'Story', 'Novel', 'Author']);

export function normalizeMovie(raw: Raw, region: string): TmdbTitle {
  const crew = list((raw.credits as Raw | undefined)?.crew);
  const externalIds = (raw.external_ids as Raw | undefined) ?? {};
  return {
    kind: 'movie',
    tmdbId: num(raw.id) ?? 0,
    name: str(raw.title),
    originalName: str(raw.original_title),
    year: yearOf(raw.release_date),
    endYear: null,
    firstAirDate: str(raw.release_date) || null,
    overview: str(raw.overview),
    posterPath: str(raw.poster_path) || null,
    runtime: num(raw.runtime) || null,
    genres: names(list(raw.genres)),
    voteAverage: num(raw.vote_average),
    voteCount: num(raw.vote_count) ?? 0,
    originalLanguage: str(raw.original_language),
    countries: names(list(raw.production_countries), 'iso_3166_1'),
    directors: unique(names(crew.filter((person) => str(person.job) === 'Director'))),
    writers: unique(names(crew.filter((person) => WRITING_JOBS.has(str(person.job))))).slice(0, 5),
    cast: cast(raw.credits),
    keywords: names(list((raw.keywords as Raw | undefined)?.keywords)),
    imdbId: str(externalIds.imdb_id) || str(raw.imdb_id) || null,
    status: str(raw.status),
    seasons: null,
    episodes: null,
    recommendations: refs(raw.recommendations, 'movie'),
    similar: refs(raw.similar, 'movie'),
    availability: availability(raw['watch/providers'], region),
  };
}

const ENDED = new Set(['Ended', 'Canceled', 'Cancelled']);

export function normalizeSeries(raw: Raw, region: string): TmdbTitle {
  const externalIds = (raw.external_ids as Raw | undefined) ?? {};
  const runtimes = Array.isArray(raw.episode_run_time) ? (raw.episode_run_time as unknown[]).map(num) : [];
  const status = str(raw.status);
  return {
    kind: 'series',
    tmdbId: num(raw.id) ?? 0,
    name: str(raw.name),
    originalName: str(raw.original_name),
    year: yearOf(raw.first_air_date),
    endYear: ENDED.has(status) ? yearOf(raw.last_air_date) : null,
    firstAirDate: str(raw.first_air_date) || null,
    overview: str(raw.overview),
    posterPath: str(raw.poster_path) || null,
    runtime: runtimes.find((value): value is number => value != null && value > 0) ?? null,
    genres: names(list(raw.genres)),
    voteAverage: num(raw.vote_average),
    voteCount: num(raw.vote_count) ?? 0,
    originalLanguage: str(raw.original_language),
    countries: Array.isArray(raw.origin_country) ? (raw.origin_country as unknown[]).map(str).filter(Boolean) : [],
    directors: unique(names(list(raw.created_by))),
    writers: [],
    cast: cast(raw.credits),
    keywords: names(list((raw.keywords as Raw | undefined)?.results)),
    imdbId: str(externalIds.imdb_id) || null,
    status,
    seasons: num(raw.number_of_seasons),
    episodes: num(raw.number_of_episodes),
    recommendations: refs(raw.recommendations, 'series'),
    similar: refs(raw.similar, 'series'),
    availability: availability(raw['watch/providers'], region),
  };
}

export function normalizeSearchResult(raw: Raw, fallbackKind?: Kind): SearchResult | null {
  const mediaType = str(raw.media_type);
  const kind: Kind | undefined = mediaType === 'movie' ? 'movie' : mediaType === 'tv' ? 'series' : mediaType ? undefined : fallbackKind;
  const id = num(raw.id);
  if (!kind || id == null) return null;
  const name = kind === 'movie' ? str(raw.title) : str(raw.name);
  if (!name) return null;
  return {
    kind,
    tmdbId: id,
    name,
    originalName: kind === 'movie' ? str(raw.original_title) : str(raw.original_name),
    year: yearOf(kind === 'movie' ? raw.release_date : raw.first_air_date),
    posterPath: str(raw.poster_path) || null,
    popularity: num(raw.popularity) ?? 0,
    originCountry: Array.isArray(raw.origin_country) ? (raw.origin_country as unknown[]).map(str).filter(Boolean) : [],
  };
}

// ---------------------------------------------------------------- requests

export async function searchTitles(key: string, query: string, options: { kind?: Kind; year?: number | null } = {}): Promise<SearchResult[]> {
  const text = query.trim();
  if (!text) return [];
  if (!options.kind) {
    const data = await tmdbGet<{ results?: Raw[] }>(key, '/search/multi', { query: text, include_adult: 'false' });
    return list(data.results)
      .map((item) => normalizeSearchResult(item))
      .filter((result): result is SearchResult => result !== null);
  }
  const path = options.kind === 'movie' ? '/search/movie' : '/search/tv';
  const yearParam = options.kind === 'movie' ? 'primary_release_year' : 'first_air_date_year';
  const data = await tmdbGet<{ results?: Raw[] }>(key, path, {
    query: text,
    include_adult: 'false',
    [yearParam]: options.year ?? undefined,
  });
  return list(data.results)
    .map((item) => normalizeSearchResult(item, options.kind))
    .filter((result): result is SearchResult => result !== null);
}

export async function fetchDetails(key: string, kind: Kind, tmdbId: number, region: string): Promise<TmdbTitle> {
  const raw = await tmdbGet<Raw>(key, `/${kind === 'movie' ? 'movie' : 'tv'}/${tmdbId}`, {
    append_to_response: DETAIL_SECTIONS.join(','),
  });
  return kind === 'movie' ? normalizeMovie(raw, region) : normalizeSeries(raw, region);
}

/** Finds a title's TMDB entry from its IMDb id. */
export async function findByImdb(key: string, imdbId: string): Promise<TitleRef | null> {
  const data = await tmdbGet<{ movie_results?: Raw[]; tv_results?: Raw[] }>(key, `/find/${encodeURIComponent(imdbId)}`, {
    external_source: 'imdb_id',
  });
  const movie = num(list(data.movie_results)[0]?.id);
  if (movie != null) return { kind: 'movie', tmdbId: movie };
  const series = num(list(data.tv_results)[0]?.id);
  return series != null ? { kind: 'series', tmdbId: series } : null;
}

export const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
export const posterUrl = (path: string, size: 'w92' | 'w185' | 'w342' = 'w342') => `${TMDB_IMAGE}/${size}${path}`;
export const logoUrl = (path: string) => `${TMDB_IMAGE}/w92${path}`;
