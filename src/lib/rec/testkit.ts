// Hand-written sample data for the recommender's unit tests. Not used by the app.

import type { Kind, OmdbScores } from '../types';
import type { FeatureRow } from './features';
import { noFeedback, START_WEIGHTS, type LibraryTitle, type RecInput } from './types';

export const NOW = Date.UTC(2026, 10, 18);

export function featureFor(key: string, tokens: string[], extra: Partial<FeatureRow> = {}): FeatureRow {
  const [kind, id] = key.split(':');
  return {
    key,
    kind: kind as Kind,
    tmdbId: Number(id),
    name: `Title ${key}`,
    year: 2010,
    endYear: null,
    posterPath: null,
    runtime: 100,
    tokens,
    labels: tokens.map((token) => `Label ${token}`),
    genres: tokens.filter((token) => token.startsWith('g:')),
    collection: null,
    tmdbVote: 7,
    tmdbVotes: 1000,
    imdbId: null,
    popularity: 10,
    recs: [],
    sims: [],
    offers: null,
    ...extra,
  };
}

/** A title both people watched together, with an agreed rating. */
export function seenTogether(id: string, key: string, score: number, extra: Partial<LibraryTitle> = {}): LibraryTitle {
  return {
    id,
    key,
    kind: key.startsWith('series') ? 'series' : 'movie',
    name: `Seen ${id}`,
    ratings: { US: { score, at: NOW } },
    states: { A: { status: 'watched', rewatch: false, at: NOW }, B: { status: 'watched', rewatch: false, at: NOW } },
    events: [{ participants: 3, completion: 1, isRewatch: false, at: NOW }],
    ...extra,
  };
}

export function inputFor(library: LibraryTitle[], features: FeatureRow[], pool: string[], extra: Partial<RecInput> = {}): RecInput {
  return {
    now: NOW,
    library,
    features: new Map(features.map((row) => [row.key, row])),
    omdb: new Map<string, OmdbScores>(),
    pool: new Map(pool.map((key) => [key, ['test']])),
    region: 'CA',
    services: null,
    names: { A: 'Sam', B: 'Alex' },
    weights: START_WEIGHTS,
    feedback: noFeedback(),
    ...extra,
  };
}

/**
 * Two tastes: science fiction by one director, liked (9 to 10), and comedy by
 * another, disliked (6 to 7.5), with some neutral dramas. The pool holds new
 * titles of each kind. TMDB scores favour the comedies, so a ranking by
 * quality alone gets it wrong and the content model has to get it right.
 */
export function twoTasteWorld(options: { omdbForPool?: boolean } = {}) {
  const features: FeatureRow[] = [];
  const library: LibraryTitle[] = [];
  const pool: string[] = [];
  const omdb = new Map<string, OmdbScores>();

  for (let i = 0; i < 20; i++) {
    const key = `movie:${100 + i}`;
    features.push(featureFor(key, ['d:1', 'g:878', 'k:10', 'k:11', `k:${1000 + i}`], { tmdbVote: 6.6, name: `Space ${i}` }));
    library.push(seenTogether(`x${i}`, key, i % 2 ? 9 : 10, { name: `Space ${i}` }));
  }
  for (let i = 0; i < 20; i++) {
    const key = `movie:${200 + i}`;
    features.push(featureFor(key, ['d:2', 'g:35', 'k:20', 'k:21', `k:${2000 + i}`], { tmdbVote: 7.8, name: `Laugh ${i}` }));
    library.push(seenTogether(`y${i}`, key, i % 2 ? 6 : 7.5, { name: `Laugh ${i}` }));
  }
  for (let i = 0; i < 12; i++) {
    const key = `movie:${300 + i}`;
    features.push(featureFor(key, ['d:3', 'g:18', 'k:30', `k:${3000 + i}`], { tmdbVote: 7.2, name: `Drama ${i}` }));
    library.push(seenTogether(`z${i}`, key, 8, { name: `Drama ${i}` }));
  }
  // Pool: new titles of each taste. Liked titles recommend the first ten sci-fi ones.
  for (let i = 0; i < 30; i++) {
    const sci = `movie:${400 + i}`;
    const com = `movie:${500 + i}`;
    const dra = `movie:${600 + i}`;
    features.push(featureFor(sci, ['d:1', 'g:878', 'k:10', `k:${4000 + i}`], { tmdbVote: 6.5, name: `New space ${i}` }));
    features.push(featureFor(com, ['d:2', 'g:35', 'k:20', `k:${5000 + i}`], { tmdbVote: 8, name: `New laugh ${i}` }));
    features.push(featureFor(dra, ['d:3', 'g:18', 'k:30', `k:${6000 + i}`], { tmdbVote: 7.1, name: `New drama ${i}` }));
    pool.push(sci, com, dra);
    if (options.omdbForPool) {
      for (const key of [sci, com, dra]) omdb.set(key, { imdbRating: 7, imdbVotes: 50_000, rottenTomatoes: null, metacritic: null });
    }
  }
  for (let i = 0; i < 20; i++) features[i].recs = Array.from({ length: 10 }, (_, j) => `movie:${400 + j}`);
  return { features, library, pool, omdb };
}
