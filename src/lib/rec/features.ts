// What the recommender needs from one cached TMDB record: its feature tokens
// for the content model, its recommendation lists for the collaborative
// signal, its TMDB score, and where it can be watched. Pure, unit tested.
//
// Tokens carry TMDB ids ("d:525" is a director or creator), so the same
// person or keyword matches across titles whatever its spelling.

import { TMDB_SHAPE_VERSION, type Kind, type TmdbTitle } from '../types';

/** Bump when the tokens change, so stored rows are rebuilt. */
export const FEATURE_VERSION = 1;

export type Family = 'd' | 'g' | 'k' | 'c' | 'w' | 'y' | 'l' | 'r' | 'f';

/** Weight of each family of features (spec, section 3). */
export const FAMILY_WEIGHT: Record<Family, number> = {
  d: 1.5, // director or creator
  g: 1.0, // genre
  k: 1.0, // keyword
  c: 0.75, // top three cast
  w: 0.5, // writer
  y: 0.5, // decade
  l: 0.5, // original language
  r: 0.25, // runtime bucket
  f: 0.25, // format bucket
};

export const familyOf = (token: string) => token.slice(0, token.indexOf(':')) as Family;

export interface Offer {
  id: number;
  name: string;
}

export interface Offers {
  region: string;
  stream: Offer[];
  free: Offer[];
  ads: Offer[];
  rent: Offer[];
  buy: Offer[];
}

export interface FeatureRow {
  key: string;
  kind: Kind;
  tmdbId: number;
  name: string;
  year: number | null;
  endYear: number | null;
  posterPath: string | null;
  runtime: number | null;
  /** Feature tokens, each with a display label at the same index. */
  tokens: string[];
  labels: string[];
  /** Genre tokens in TMDB's order; the first is the primary genre. */
  genres: string[];
  /** Movies: the franchise it belongs to. */
  collection: number | null;
  tmdbVote: number | null;
  tmdbVotes: number;
  imdbId: string | null;
  popularity: number;
  /** TMDB's recommendation list, in order, as keys. */
  recs: string[];
  /** TMDB's similar-titles list, in order, as keys. */
  sims: string[];
  offers: Offers | null;
}

export const keyOf = (kind: Kind, tmdbId: number) => `${kind}:${tmdbId}`;

let languageNames: Intl.DisplayNames | null | undefined;
function languageName(code: string): string {
  if (languageNames === undefined) {
    try {
      languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      languageNames = null;
    }
  }
  try {
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function runtimeToken(kind: Kind, runtime: number | null): [string, string] | null {
  if (runtime == null || runtime <= 0) return null;
  if (kind === 'movie') {
    if (runtime < 90) return ['r:m90', 'under 90 minutes'];
    if (runtime < 120) return ['r:m120', '90 minutes to 2 hours'];
    if (runtime < 150) return ['r:m150', '2 to 2½ hours'];
    return ['r:mlong', 'over 2½ hours'];
  }
  if (runtime < 35) return ['r:s30', 'half-hour episodes'];
  if (runtime <= 75) return ['r:s60', 'hour-long episodes'];
  return ['r:slong', 'feature-length episodes'];
}

function formatToken(title: TmdbTitle): [string, string] {
  if (title.kind === 'movie') return ['f:movie', 'film'];
  if (title.seasons === 1 && title.endYear != null) return ['f:limited', 'limited series'];
  return ['f:series', 'series'];
}

/** Builds the feature row for a record, or null if it predates the ids (version 1). */
export function featureRow(title: TmdbTitle): FeatureRow | null {
  if ((title.version ?? 1) < TMDB_SHAPE_VERSION) return null;
  const tokens: string[] = [];
  const labels: string[] = [];
  const add = (token: string, label: string) => {
    if (!label || tokens.includes(token)) return;
    tokens.push(token);
    labels.push(label);
  };
  const addIds = (family: Family, ids: number[] | undefined, names: string[], limit = Infinity) => {
    (ids ?? []).slice(0, limit).forEach((id, index) => {
      if (id > 0) add(`${family}:${id}`, names[index] ?? '');
    });
  };

  addIds('d', title.directorIds, title.directors);
  addIds('g', title.genreIds, title.genres);
  addIds('k', title.keywordIds, title.keywords);
  addIds(
    'c',
    title.castIds,
    title.cast.map((person) => person.name),
    3,
  );
  addIds('w', title.writerIds, title.writers);
  if (title.year != null) {
    const decade = Math.floor(title.year / 10) * 10;
    add(`y:${decade}`, `${decade}s`);
  }
  if (title.originalLanguage) add(`l:${title.originalLanguage}`, languageName(title.originalLanguage));
  const runtime = runtimeToken(title.kind, title.runtime);
  if (runtime) add(...runtime);
  add(...formatToken(title));

  const offers = (list: { id: number; name: string }[]) => list.map((provider) => ({ id: provider.id, name: provider.name }));
  const availability = title.availability;

  return {
    key: keyOf(title.kind, title.tmdbId),
    kind: title.kind,
    tmdbId: title.tmdbId,
    name: title.name,
    year: title.year,
    endYear: title.endYear,
    posterPath: title.posterPath,
    runtime: title.runtime,
    tokens,
    labels,
    genres: tokens.filter((token) => token.startsWith('g:')),
    collection: title.collectionId ?? null,
    tmdbVote: title.voteAverage,
    tmdbVotes: title.voteCount,
    imdbId: title.imdbId,
    popularity: title.popularity ?? 0,
    recs: title.recommendations.map((ref) => keyOf(ref.kind, ref.tmdbId)),
    sims: title.similar.map((ref) => keyOf(ref.kind, ref.tmdbId)),
    offers: availability
      ? {
          region: availability.region,
          stream: offers(availability.stream),
          free: offers(availability.free),
          ads: offers(availability.ads),
          rent: offers(availability.rent),
          buy: offers(availability.buy),
        }
      : null,
  };
}
