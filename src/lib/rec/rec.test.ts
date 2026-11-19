import { describe, expect, it } from 'vitest';
import { normalizeMovie, normalizeSeries } from '../gateway/tmdb';
import { backtestMode, MIN_RATED, runBacktest } from './backtest';
import { buildSlate, buildSlates, createContext, eligibility, EXPLORATORY_POSITIONS } from './engine';
import { featureRow } from './features';
import { buildProfile, explicitRating, implicitSignal, referencePoints } from './profile';
import { fit, phrase, REASON_MAX } from './reasons';
import { sample, seededRandom } from './random';
import { availability, blend, buildCfIndex, collaborative, quality } from './score';
import { featureFor, inputFor, NOW, seenTogether, twoTasteWorld } from './testkit';
import { START_WEIGHTS, type LibraryTitle } from './types';
import { dot, VectorSpace } from './vectors';

const RAW_MOVIE = {
  id: 11,
  title: 'Sample Film',
  original_title: 'Sample Film',
  release_date: '1994-05-01',
  runtime: 142,
  original_language: 'fr',
  vote_average: 8.1,
  vote_count: 900,
  popularity: 12.5,
  genres: [
    { id: 18, name: 'Drama' },
    { id: 80, name: 'Crime' },
  ],
  belongs_to_collection: { id: 77, name: 'Sample Collection' },
  credits: {
    cast: [
      { id: 4, name: 'Fourth', order: 3 },
      { id: 1, name: 'First', order: 0 },
      { id: 2, name: 'Second', order: 1 },
      { id: 3, name: 'Third', order: 2 },
    ],
    crew: [
      { id: 9, name: 'Dee Rector', job: 'Director' },
      { id: 9, name: 'Dee Rector', job: 'Director' },
      { id: 8, name: 'Wry Ter', job: 'Screenplay' },
    ],
  },
  keywords: { keywords: [{ id: 500, name: 'heist' }] },
  external_ids: { imdb_id: 'tt0000011' },
  recommendations: { results: [{ id: 12, media_type: 'movie' }, { id: 13 }] },
  similar: { results: [{ id: 14 }] },
  'watch/providers': { results: { CA: { flatrate: [{ provider_id: 8, provider_name: 'Stream Co' }], rent: [{ provider_id: 3, provider_name: 'Rent Co' }] } } },
};

describe('feature rows', () => {
  it('keep ids, top three cast and the families of tokens', () => {
    const row = featureRow(normalizeMovie(RAW_MOVIE, 'CA'))!;
    expect(row.key).toBe('movie:11');
    expect(row.tokens).toEqual(['d:9', 'g:18', 'g:80', 'k:500', 'c:1', 'c:2', 'c:3', 'w:8', 'y:1990', 'l:fr', 'r:m150', 'f:movie']);
    expect(row.labels[0]).toBe('Dee Rector');
    expect(row.labels[9]).toBe('French');
    expect(row.genres).toEqual(['g:18', 'g:80']);
    expect(row.collection).toBe(77);
    expect(row.recs).toEqual(['movie:12', 'movie:13']);
    expect(row.sims).toEqual(['movie:14']);
    expect(row.offers?.stream).toEqual([{ id: 8, name: 'Stream Co' }]);
  });

  it('use creators for series and mark one-season ended series as limited', () => {
    const series = normalizeSeries(
      {
        id: 21,
        name: 'Short Run',
        first_air_date: '2020-01-01',
        last_air_date: '2020-03-01',
        status: 'Ended',
        number_of_seasons: 1,
        episode_run_time: [28],
        created_by: [{ id: 5, name: 'Cree Ator' }],
        genres: [{ id: 35, name: 'Comedy' }],
      },
      'CA',
    );
    const row = featureRow(series)!;
    expect(row.tokens).toContain('d:5');
    expect(row.tokens).toContain('f:limited');
    expect(row.tokens).toContain('r:s30');
  });

  it('are not built from records saved before ids were kept', () => {
    const old = { ...normalizeMovie(RAW_MOVIE, 'CA') };
    delete old.version;
    expect(featureRow(old)).toBeNull();
  });
});

describe('vectors', () => {
  it('have unit length and weigh rare tokens more', () => {
    const space = new VectorSpace([
      featureFor('movie:1', ['g:18', 'k:1']),
      featureFor('movie:2', ['g:18', 'k:2']),
      featureFor('movie:3', ['g:18', 'k:3']),
    ]);
    const v = space.vector('movie:1')!;
    expect(dot(v, v)).toBeCloseTo(1);
    const genre = v.vals[v.cols.indexOf(space.index.get('g:18')!)];
    const keyword = v.vals[v.cols.indexOf(space.index.get('k:1')!)];
    expect(keyword).toBeGreaterThan(genre);
    expect(dot(v, space.vector('movie:2')!)).toBeGreaterThan(0);
  });
});

describe('reference points', () => {
  it("match the household's from the spec: liked 9, neutral 8, disliked 7.5", () => {
    // 146 ratings: 43 at 9 or more (29%), 38 at 7.5 or less (26%), the rest 8 or 8.5.
    const scores = [...Array(30).fill(9), ...Array(13).fill(9.5), ...Array(40).fill(8), ...Array(25).fill(8.5), ...Array(28).fill(7.5), ...Array(10).fill(7)];
    expect(scores).toHaveLength(146);
    expect(referencePoints(scores)).toEqual({ liked: 9, neutral: 8, disliked: 7.5 });
  });
});

describe('profiles', () => {
  const library: LibraryTitle[] = [
    seenTogether('t1', 'movie:1', 9, { ratings: { US: { score: 9, at: NOW }, A: { score: 6, at: NOW } } }),
    seenTogether('t2', 'movie:2', 7),
  ];

  it('use a person’s own rating, else the agreed one; Together uses only agreed ratings', () => {
    expect(explicitRating(library[0], 'A')?.score).toBe(6);
    expect(explicitRating(library[0], 'B')?.score).toBe(9);
    expect(explicitRating(library[0], 'US')?.score).toBe(9);
  });

  it('place implicit signals on the rater’s scale', () => {
    const points = { liked: 9, neutral: 8, disliked: 7.5 };
    const base: LibraryTitle = { id: 'u', key: 'movie:9', kind: 'movie', name: 'Unrated', ratings: {}, states: {}, events: [] };
    const state = (status: LibraryTitle['states']['A'] extends infer S ? S : never) => ({ ...base, states: { A: status } });
    expect(implicitSignal(state({ status: 'watched', rewatch: true, at: NOW }), 'A', points)?.value).toBe(9);
    expect(implicitSignal(state({ status: 'not_interested', rewatch: false, at: NOW }), 'A', points)?.value).toBe(6.5);
    expect(implicitSignal(state({ status: 'watched', rewatch: false, at: NOW }), 'A', points)?.value).toBe(8);
    expect(implicitSignal(state({ status: 'watchlist', rewatch: false, at: NOW }), 'A', points)).toEqual({ value: 8.5, weight: 0.25, at: NOW });
    const stopped = { ...base, events: [{ participants: 1, completion: 0.4, isRewatch: false, at: NOW }] };
    expect(implicitSignal(stopped, 'A', points)?.value).toBe(6.5);
    expect(implicitSignal(stopped, 'B', points)).toBeUndefined();
  });

  it('point the centroid toward liked titles and away from disliked ones', () => {
    const world = twoTasteWorld();
    const space = new VectorSpace(world.features);
    const profile = buildProfile(world.library, 'US', space, NOW);
    expect(profile.centroid[space.index.get('d:1')!]).toBeGreaterThan(0);
    expect(profile.centroid[space.index.get('d:2')!]).toBeLessThan(0);
    expect(profile.liked.every((entry) => entry.value >= profile.points.liked)).toBe(true);
    const held = buildProfile(world.library, 'US', space, NOW, new Set(['movie:100']));
    expect(held.entries.some((entry) => entry.key === 'movie:100')).toBe(false);
  });
});

describe('components', () => {
  it('shrink audience scores with few votes toward the prior', () => {
    const few = quality({ imdb: 9.5, imdbVotes: 10, rt: null, mc: null, tmdb: null, tmdbVotes: 0 })!;
    const many = quality({ imdb: 9.5, imdbVotes: 500_000, rt: null, mc: null, tmdb: null, tmdbVotes: 0 })!;
    expect(few).toBeCloseTo(0.68, 1);
    expect(many).toBeCloseTo(0.95, 2);
    expect(quality({ imdb: null, imdbVotes: null, rt: null, mc: null, tmdb: null, tmdbVotes: 0 })).toBeUndefined();
  });

  it('score the collaborative signal from positions in liked titles’ lists', () => {
    const features = new Map([['movie:1', featureFor('movie:1', [], { recs: ['movie:5', 'movie:6'] })]]);
    const index = buildCfIndex([{ key: 'movie:1', titleId: 't', name: 'Liked', value: 9, weight: 1, at: NOW, explicit: true }], features);
    expect(index.get('movie:5')?.sum).toBe(1);
    expect(index.get('movie:6')?.sum).toBe(0.5);
    expect(collaborative(index.get('movie:6'))).toBeGreaterThanOrEqual(0.5);
    expect(collaborative(undefined)).toBeUndefined();
    expect(collaborative(undefined, 'zero')).toBe(0);
  });

  it('give a missing component’s weight to the others', () => {
    const mixed = blend({ content: 0.8, quality: 0.6 }, START_WEIGHTS)!;
    expect(mixed.weights.content! + mixed.weights.quality!).toBeCloseTo(1);
    expect(mixed.score).toBeCloseTo((0.45 * 0.8 + 0.2 * 0.6) / 0.65);
    expect(mixed.contributions.content! + mixed.contributions.quality!).toBeCloseTo(mixed.score);
  });

  it('demote titles that cost extra or cannot be watched', () => {
    const offers = { region: 'CA', stream: [{ id: 8, name: 'Stream Co' }], free: [], ads: [], rent: [{ id: 3, name: 'Rent Co' }], buy: [] };
    expect(availability(offers, 'CA', new Set([8])).factor).toBe(1);
    expect(availability(offers, 'CA', new Set([99]))).toEqual({ factor: 0.85, label: "On Stream Co, which you don't have" });
    expect(availability(offers, 'CA', null).factor).toBe(1);
    expect(availability({ ...offers, stream: [] }, 'CA', null).factor).toBe(0.85);
    expect(availability(offers, 'US', null).factor).toBe(0.7);
    expect(availability(null, 'CA', null).factor).toBe(0.7);
  });
});

describe('eligibility', () => {
  const title = (extra: Partial<LibraryTitle>): LibraryTitle => ({ id: 't', key: 'movie:1', kind: 'movie', name: 'T', ratings: {}, states: {}, events: [], ...extra });

  it('drops seen titles unless flagged would-rewatch, and vetoes not interested for Together', () => {
    expect(eligibility(title({}), 'A').type).toBe('new');
    const seen = seenTogether('s', 'movie:1', 9);
    expect(eligibility(seen, 'A').type).toBe('excluded');
    const rewatchA = { ...seen, states: { ...seen.states, A: { status: 'watched' as const, rewatch: true, at: NOW } } };
    expect(eligibility(rewatchA, 'A')).toEqual({ type: 'rewatch', score: 9, seenBy: ['A'] });
    expect(eligibility(rewatchA, 'US').type).toBe('excluded');
    const notForB = title({ states: { B: { status: 'not_interested', rewatch: false, at: NOW } } });
    expect(eligibility(notForB, 'A').type).toBe('new');
    expect(eligibility(notForB, 'US').type).toBe('excluded');
  });

  it('lets Together rewatch a title one person saw and flagged, at their rating', () => {
    const onlyA = title({ ratings: { A: { score: 8.5, at: NOW } }, states: { A: { status: 'watched', rewatch: true, at: NOW } } });
    expect(eligibility(onlyA, 'US')).toEqual({ type: 'rewatch', score: 8.5, seenBy: ['A'] });
    expect(eligibility(onlyA, 'B').type).toBe('new');
  });
});

describe('slates', () => {
  it('rank the liked taste first, hold exploratory slots, and explain each pick briefly', () => {
    const world = twoTasteWorld({ omdbForPool: true });
    const input = inputFor(world.library, world.features, world.pool, { omdb: world.omdb });
    const slate = buildSlate(createContext(input), 'US');
    expect(slate.picks).toHaveLength(20);
    const ranked = slate.picks.filter((pick) => !pick.exploratory);
    expect(ranked[0].name).toMatch(/^New space/);
    expect(ranked.slice(0, 8).every((pick) => !pick.name.startsWith('New laugh'))).toBe(true);
    expect(slate.picks.every((pick) => pick.reason.length <= REASON_MAX)).toBe(true);
    expect(slate.picks.some((pick) => /Space \d+/.test(pick.reason))).toBe(true);
    expect(slate.picks.every((pick) => !pick.titleId)).toBe(true);
    // At most 8 of 20 share a primary genre.
    const genres = new Map<string, number>();
    for (const pick of slate.picks) {
      const genre = input.features.get(pick.key)!.genres[0];
      genres.set(genre, (genres.get(genre) ?? 0) + 1);
    }
    expect(Math.max(...genres.values())).toBeLessThanOrEqual(8);
    expect(slate.stats.topCandidates.length).toBeGreaterThan(0);
  });

  it('put cold titles only in the exploratory positions', () => {
    const world = twoTasteWorld({ omdbForPool: true });
    // Six mysteries by the liked director that nobody recommends and with no review scores: cold.
    for (let i = 10; i < 16; i++) {
      const key = `movie:${400 + i}`;
      world.omdb.delete(key);
      Object.assign(world.features.find((row) => row.key === key)!, { tokens: ['g:9648', 'd:1', 'k:10', 'k:11'], genres: ['g:9648'] });
      world.features.find((row) => row.key === key)!.labels = ['Mystery', 'Dee Rector', 'space', 'ships'];
    }
    const slates = buildSlates(inputFor(world.library, world.features, world.pool, { omdb: world.omdb }));
    for (const slate of slates) {
      const positions = slate.picks.flatMap((pick, index) => (pick.exploratory ? [index + 1] : []));
      expect(positions).toEqual(EXPLORATORY_POSITIONS);
      const cold = slate.picks.filter((pick) => pick.exploratory);
      expect(cold.every((pick) => Number(pick.key.split(':')[1]) >= 410 && Number(pick.key.split(':')[1]) < 416)).toBe(true);
      expect(cold.every((pick) => pick.reason.startsWith('Exploratory: not widely rated yet; picked for'))).toBe(true);
    }
  });

  it('move exploratory picks up when there are too few ranked ones', () => {
    // No review scores for the pool: only the ten recommended sci-fi titles rank.
    const world = twoTasteWorld();
    for (let i = 10; i < 16; i++) {
      const row = world.features.find((candidate) => candidate.key === `movie:${400 + i}`)!;
      Object.assign(row, { tokens: ['g:9648', 'd:1', 'k:10', 'k:11'], labels: ['Mystery', 'Dee Rector', 'space', 'ships'], genres: ['g:9648'] });
    }
    const slate = buildSlates(inputFor(world.library, world.features, world.pool))[2];
    expect(slate.picks.filter((pick) => !pick.exploratory)).toHaveLength(10);
    expect(slate.picks.flatMap((pick, index) => (pick.exploratory ? [index + 1] : []))).toEqual([5, 10, 13, 14]);
  });

  it('fill exploratory places from genres the viewer rarely watches, never from ones they rate poorly', () => {
    const world = twoTasteWorld({ omdbForPool: true });
    for (let i = 0; i < 6; i++) {
      const key = `movie:${800 + i}`;
      world.features.push(featureFor(key, ['d:9', 'g:99', `k:${8000 + i}`], { tmdbVote: 8.6, name: `Documentary ${i}` }));
      world.pool.push(key);
      world.omdb.set(key, { imdbRating: 8.4, imdbVotes: 40_000, rottenTomatoes: 97, metacritic: 88 });
    }
    const slate = buildSlates(inputFor(world.library, world.features, world.pool, { omdb: world.omdb }))[0];
    const exploratory = slate.picks.filter((pick) => pick.exploratory);
    expect(slate.picks.flatMap((pick, index) => (pick.exploratory ? [index + 1] : []))).toEqual([5, 10, 15, 20]);
    expect(exploratory.every((pick) => pick.name.startsWith('Documentary'))).toBe(true);
    expect(exploratory[0].reason).toBe('Exploratory: well reviewed, and outside your usual genres.');
  });

  it('let the genre cap give way when nothing else can fill the slate', () => {
    // Every candidate is science fiction: the cap of 8 per genre would leave a short slate.
    const world = twoTasteWorld({ omdbForPool: true });
    const scifi = world.pool.filter((key) => Number(key.split(':')[1]) < 500);
    const slate = buildSlates(inputFor(world.library, world.features, scifi, { omdb: world.omdb }))[2];
    expect(slate.picks).toHaveLength(20);
  });

  it('give unfilled exploratory slots to ranked picks', () => {
    const world = twoTasteWorld({ omdbForPool: true });
    const slate = buildSlates(inputFor(world.library, world.features, world.pool, { omdb: world.omdb }))[0];
    expect(slate.picks).toHaveLength(20);
    expect(slate.picks.some((pick) => pick.exploratory)).toBe(false);
  });

  it('allow at most two rewatches and at most two titles of a franchise', () => {
    const world = twoTasteWorld({ omdbForPool: true });
    const library = world.library.map((title, index) =>
      index < 5 ? { ...title, states: { A: { status: 'watched' as const, rewatch: true, at: NOW }, B: title.states.B } } : title,
    );
    world.features.filter((row) => row.key.startsWith('movie:4')).forEach((row) => (row.collection = 9));
    const slate = buildSlate(createContext(inputFor(library, world.features, world.pool, { omdb: world.omdb })), 'A');
    expect(slate.picks.filter((pick) => pick.rewatch)).toHaveLength(2);
    expect(slate.picks.filter((pick) => pick.rewatch).every((pick) => pick.reason === "You've seen this and would watch it again.")).toBe(true);
    expect(slate.picks.filter((pick) => world.features.find((row) => row.key === pick.key)?.collection === 9).length).toBeLessThanOrEqual(2);
  });
});

describe('reasons', () => {
  it('vary the titles they cite across a slate when others are nearly as strong', () => {
    const world = twoTasteWorld({ omdbForPool: true });
    const slate = buildSlate(createContext(inputFor(world.library, world.features, world.pool, { omdb: world.omdb })), 'US');
    const personal = slate.picks.filter((pick) => /^(People who liked|Shares)/.test(pick.reason));
    expect(personal.length).toBeGreaterThan(3);
    expect(new Set(personal.map((pick) => pick.reason)).size).toBeGreaterThan(personal.length / 2);
  });

  it('say only what is true when nothing in the history applies', () => {
    const world = twoTasteWorld({ omdbForPool: true });
    const slate = buildSlate(createContext(inputFor(world.library, world.features, world.pool, { omdb: world.omdb })), 'US');
    expect(slate.picks.some((pick) => pick.reason.includes('close to what you watch'))).toBe(false);
  });

  it('shorten a long title to fit 140 characters', () => {
    const text = fit((title) => `Shares director Someone and ‘a theme’ with ${title}, which you rated 9.`, 'A'.repeat(200));
    expect(text.length).toBeLessThanOrEqual(REASON_MAX);
    expect(text).toContain('…');
  });

  it('phrase each kind of feature', () => {
    expect(phrase('d:1', 'Dee Rector', 'movie')).toBe('director Dee Rector');
    expect(phrase('d:1', 'Cree Ator', 'series')).toBe('creator Cree Ator');
    expect(phrase('k:1', 'heist', 'movie')).toBe('‘heist’');
    expect(phrase('g:18', 'Drama', 'movie')).toBe('drama');
  });
});

describe('backtest', () => {
  it('finds the model beating a quality-only baseline when quality points the wrong way', () => {
    const world = twoTasteWorld();
    const [result] = runBacktest(inputFor(world.library, world.features, world.pool), 202611, 5);
    expect(result.mode).toBe('A');
    expect(result.rated).toBe(52);
    expect(result.testSize).toBe(10);
    expect(result.poolSample).toBe(90);
    expect(result.results!.model.precision).toBeGreaterThan(result.results!.baseline.precision);
    expect(result.lift!).toBeGreaterThan(0.05);
  });

  it('repeats exactly for the same seed', () => {
    const world = twoTasteWorld();
    const input = inputFor(world.library, world.features, world.pool);
    expect(runBacktest(input, 7, 3)).toEqual(runBacktest(input, 7, 3));
  });

  it('declines to report with too few rated titles', () => {
    const world = twoTasteWorld();
    const input = inputFor(world.library.slice(0, MIN_RATED - 1), world.features, world.pool);
    expect(backtestMode(createContext(input), 'A', 1).results).toBeNull();
  });
});

describe('seeded sampling', () => {
  it('draws without repeats and repeats for a seed', () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const first = sample(items, 10, seededRandom(3));
    expect(new Set(first).size).toBe(10);
    expect(sample(items, 10, seededRandom(3))).toEqual(first);
  });
});
