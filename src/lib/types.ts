export type Kind = 'movie' | 'series';
export type ProfileId = 'A' | 'B';
/** 'US' is the household's agreed rating. */
export type Rater = ProfileId | 'US';
export type Status = 'watchlist' | 'watching' | 'watched' | 'dropped' | 'not_interested';
/** Who took part: one person, or both together. */
export type Who = ProfileId | 'both';

export const PROFILE_IDS: ProfileId[] = ['A', 'B'];
export const RATERS: Rater[] = ['US', 'A', 'B'];
export const STATUSES: Status[] = ['watchlist', 'watching', 'watched', 'dropped', 'not_interested'];

export const STATUS_LABEL: Record<Status, string> = {
  watchlist: 'Want to watch',
  watching: 'Watching',
  watched: 'Watched',
  dropped: 'Dropped',
  not_interested: 'Not interested',
};

export const KIND_LABEL: Record<Kind, string> = { movie: 'Movie', series: 'Series' };

export interface Profiles {
  A: string;
  B: string;
}

/** One title as the library grid needs it. */
export interface LibraryItem {
  id: string;
  kind: Kind;
  name: string;
  year: number | null;
  tmdbId: number | null;
  source: string;
  createdAt: number;
  posterPath: string | null;
  genres: string[];
  ratings: Partial<Record<Rater, number>>;
  status: Partial<Record<ProfileId, Status>>;
  wouldRewatch: Partial<Record<ProfileId, boolean>>;
  watchedTogether: boolean;
  notes: string;
}

export interface WatchEvent {
  id: string;
  participants: 1 | 2 | 3;
  watchedOn: string | null;
  completion: number;
  isRewatch: boolean;
  source: string;
  createdAt: number;
}

export interface Note {
  id: string;
  author: Rater;
  text: string;
  updatedAt: number;
}

export interface Provider {
  id: number;
  name: string;
  logoPath: string | null;
}

export interface Availability {
  region: string;
  stream: Provider[];
  free: Provider[];
  ads: Provider[];
  rent: Provider[];
  buy: Provider[];
}

export interface TitleRef {
  kind: Kind;
  tmdbId: number;
}

/**
 * The subset of a TMDB record the app keeps. TMDB data may be cached for at
 * most six months, so this lives only in cache.db.
 */
export interface TmdbTitle {
  kind: Kind;
  tmdbId: number;
  name: string;
  originalName: string;
  year: number | null;
  endYear: number | null;
  firstAirDate: string | null;
  overview: string;
  posterPath: string | null;
  runtime: number | null;
  genres: string[];
  voteAverage: number | null;
  voteCount: number;
  originalLanguage: string;
  countries: string[];
  directors: string[];
  writers: string[];
  cast: { name: string; character: string }[];
  keywords: string[];
  imdbId: string | null;
  status: string;
  seasons: number | null;
  episodes: number | null;
  recommendations: TitleRef[];
  similar: TitleRef[];
  availability: Availability | null;
}

export interface OmdbScores {
  imdbRating: number | null;
  imdbVotes: number | null;
  rottenTomatoes: number | null;
  metacritic: number | null;
}

export interface SearchResult {
  kind: Kind;
  tmdbId: number;
  name: string;
  year: number | null;
  posterPath: string | null;
  popularity: number;
}

/** Everything the title page shows about one title. */
export interface TitleDetail {
  id: string;
  kind: Kind;
  name: string;
  year: number | null;
  tmdbId: number | null;
  tmdbCheckedAt: number | null;
  imdbId: string | null;
  source: string;
  createdAt: number;
  ratings: Partial<Record<Rater, number>>;
  status: Partial<Record<ProfileId, Status>>;
  wouldRewatch: Partial<Record<ProfileId, boolean>>;
  events: WatchEvent[];
  notes: Note[];
  tmdb: TmdbTitle | null;
  tmdbFetchedAt: number | null;
  omdb: OmdbScores | null;
  omdbFetchedAt: number | null;
}
