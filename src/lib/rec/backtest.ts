// The backtest behind Settings → Recommendation check. Pure, unit tested.
//
// Each draw hides a random 20% of a rater's ratings, rebuilds the profile
// without them, and ranks the hidden titles in a list with titles the
// household has not seen, counted as not relevant. A hidden title the rater
// liked is relevant. Precision at 10 is compared with ranking the same list
// by review scores alone (the quality part): the spec's test (section 4).
//
// The unseen titles are drawn from those that came from a taste-neutral
// source: trending, popular, or the household's streaming services. Being on
// another list too (TMDB recommends most popular titles somewhere) does not
// change how they were picked. The first version drew them from the whole
// pool, which is gathered because it resembles the household's favourites; a
// working recommender ranks those first and was marked down for it
// (precision 0.02 against 0.27 for scores alone). That test is still
// reported, as is ranking the hidden titles only against each other.
//
// As in the app, the parts are turned into percentiles among the titles
// ranked together before they are blended.
//
// The check also searches the balance of the parts (content, collaborative,
// quality, in steps of 0.05) on the first 10 draws and tests the best on 10
// fresh draws, so the result is not luck in choosing among 231 balances.
// Quality comes from TMDB scores alone here (see componentScores).

import { activeWeights, componentScores, createContext, type Context } from './engine';
import { buildProfile, explicitRating, referencePoints } from './profile';
import { sample, seededRandom } from './random';
import { blend, buildCfIndex, QUALITY_PRIOR, toPercentiles } from './score';
import { isNeutral, MODES, type Components, type Mode, type RecInput, type Weights } from './types';

export const TEST_SHARE = 0.2;
export const POOL_SAMPLE = 200;
export const DRAWS = 10;
export const TOP_N = 10;
/** Fewer rated titles than this, and the check says so instead of reporting noise. */
export const MIN_RATED = 25;
export const WEIGHT_STEP = 0.05;
/** Fewer taste-neutral candidates than this, and the main test cannot run. */
export const MIN_NEUTRAL = 50;

export interface Measure {
  /** Liked titles in the top 10, divided by 10. */
  precision: number;
  /** Liked titles in the top 10, divided by the smaller of 10 and the liked titles in the list. */
  recall: number;
  /** How often a liked title ranks above a title in the list that is not liked (0.5 is chance). */
  auc: number;
}

export type Variant = 'model' | 'baseline' | 'content' | 'collaborative';
export const VARIANTS: Variant[] = ['model', 'baseline', 'content', 'collaborative'];

export interface ListResult {
  /** Unseen titles added to the hidden ones in each draw. */
  candidates: number;
  /** Expected precision at 10 of a random order. */
  chance: number;
  measures: Record<Variant, Measure>;
}

/** Mean raw parts of a group of titles (before percentiles). */
export interface GroupMeans {
  count: number;
  /** Cosine with the taste centroid. */
  content: number | null;
  /** Share on any rated title's TMDB recommendation list. */
  withCollaborative: number;
  /** Mean signed collaborative sum, among those on a list. */
  collaborative: number | null;
  quality: number | null;
}

export interface ModeBacktest {
  mode: Mode;
  /** Rated titles with TMDB details: what the test draws from. */
  rated: number;
  testSize: number;
  /** Mean number of liked titles among the hidden ones. */
  relevant: number;
  likedPoint: number;
  draws: number;
  /** The main test: hidden titles among taste-neutral unseen titles. */
  neutral: ListResult | null;
  /** neutral model precision minus neutral baseline precision: the gate. */
  lift: number | null;
  /** The best balance on the first draws of the main test, and how it does on fresh ones. */
  tuned: { weights: Weights; train: number; fresh: number; freshBaseline: number; freshLift: number } | null;
  /** The hidden titles ranked only against each other. */
  within: ListResult | null;
  /** The first version: hidden titles among the whole pool. */
  pool: ListResult | null;
  /** Mean parts for hidden liked titles, other hidden titles, and both kinds of candidate. */
  groups: Record<'liked' | 'other' | 'neutral' | 'pool', GroupMeans> | null;
  /** Taste-neutral candidates available; the main test needs MIN_NEUTRAL. */
  neutralAvailable: number;
}

interface Scored {
  key: string;
  liked: boolean;
  /** Raw parts, as componentScores gives them. */
  components: Components;
  /** The same parts as percentiles within the list being ranked. */
  ranked?: Components;
}

/** Turns each item's parts into percentiles within this list. */
function rankWithin(list: Scored[]): Scored[] {
  const copies = list.map((item) => ({ ...item, ranked: { ...item.components } }));
  const views = copies.map((item) => ({ components: item.ranked }));
  toPercentiles(views);
  return copies;
}

function valueOf(variant: Variant, item: Scored, weights: Weights): number {
  switch (variant) {
    case 'model':
      return blend(item.ranked ?? item.components, weights)?.score ?? 0;
    case 'baseline':
      return item.components.quality ?? QUALITY_PRIOR / 10;
    case 'content':
      return item.components.content ?? -1;
    case 'collaborative':
      return item.components.collaborative ?? 0;
  }
}

/** Precision, recall and AUC of one ordering. */
export function measure(items: { liked: boolean; value: number; key: string }[]): Measure {
  const ordered = [...items].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const relevant = items.filter((item) => item.liked).length;
  const hits = ordered.slice(0, TOP_N).filter((item) => item.liked).length;
  const liked = items.filter((item) => item.liked);
  const other = items.filter((item) => !item.liked);
  let wins = 0;
  for (const a of liked) for (const b of other) wins += a.value > b.value ? 1 : a.value === b.value ? 0.5 : 0;
  return {
    precision: hits / TOP_N,
    recall: relevant ? hits / Math.min(TOP_N, relevant) : 0,
    auc: liked.length && other.length ? wins / (liked.length * other.length) : 0.5,
  };
}

/** Every balance of content, collaborative and quality in steps of `step`, partner off. */
export function weightGrid(step = WEIGHT_STEP): Weights[] {
  const n = Math.round(1 / step);
  const grid: Weights[] = [];
  for (let c = 0; c <= n; c++) {
    for (let f = 0; f <= n - c; f++) {
      grid.push({ content: c / n, collaborative: f / n, quality: (n - c - f) / n, partner: 0 });
    }
  }
  return grid;
}

type Part = 'content' | 'collaborative' | 'quality';
const PARTS: Part[] = ['content', 'collaborative', 'quality'];

class Means {
  private sums = { content: 0, collaborative: 0, quality: 0 };
  private counts = { content: 0, collaborative: 0, quality: 0 };
  private n = 0;

  add(items: Scored[]): void {
    for (const item of items) {
      this.n++;
      for (const part of PARTS) {
        const value = item.components[part];
        // A collaborative 0 means no rated title lists it: no evidence, not a score.
        if (value == null || (part === 'collaborative' && value === 0)) continue;
        this.sums[part] += value;
        this.counts[part]++;
      }
    }
  }

  result(draws: number): GroupMeans {
    const mean = (part: Part) => (this.counts[part] ? this.sums[part] / this.counts[part] : null);
    return {
      count: this.n / Math.max(1, draws),
      content: mean('content'),
      withCollaborative: this.n ? this.counts.collaborative / this.n : 0,
      collaborative: mean('collaborative'),
      quality: mean('quality'),
    };
  }
}

/** Sums of measures over draws, for one kind of list. */
class Totals {
  private sums = Object.fromEntries(VARIANTS.map((variant) => [variant, { precision: 0, recall: 0, auc: 0 }])) as Record<Variant, Measure>;
  private chance = 0;
  private draws = 0;
  candidates = 0;

  /** list must already be ranked within (rankWithin). */
  add(list: Scored[], weights: Weights): void {
    this.draws++;
    // A random order puts liked titles in the top 10 at their share of the list.
    this.chance += (list.filter((item) => item.liked).length / list.length) * (Math.min(TOP_N, list.length) / TOP_N);
    for (const variant of VARIANTS) {
      const result = measure(list.map((item) => ({ key: item.key, liked: item.liked, value: valueOf(variant, item, weights) })));
      this.sums[variant].precision += result.precision;
      this.sums[variant].recall += result.recall;
      this.sums[variant].auc += result.auc;
    }
  }

  result(): ListResult | null {
    if (this.draws === 0) return null;
    const measures = Object.fromEntries(
      VARIANTS.map((variant) => [
        variant,
        {
          precision: this.sums[variant].precision / this.draws,
          recall: this.sums[variant].recall / this.draws,
          auc: this.sums[variant].auc / this.draws,
        },
      ]),
    ) as Record<Variant, Measure>;
    return { candidates: this.candidates, chance: this.chance / this.draws, measures };
  }
}

export function backtestMode(ctx: Context, mode: Mode, seed: number, draws = DRAWS): ModeBacktest {
  const { input } = ctx;
  const weights = activeWeights(input.weights);
  const rated = input.library.filter((title) => title.key && input.features.has(title.key) && explicitRating(title, mode));
  const libraryKeys = new Set(input.library.map((title) => title.key).filter(Boolean));
  const unrated = [...input.pool.keys()].filter((key) => !libraryKeys.has(key) && input.features.has(key)).sort();
  const neutral = unrated.filter((key) => isNeutral(input.pool.get(key) ?? []));
  const likedPoint = referencePoints(input.library.map((title) => explicitRating(title, mode)?.score).filter((value) => value != null)).liked;
  const testSize = Math.max(1, Math.round(rated.length * TEST_SHARE));
  const result: ModeBacktest = {
    mode,
    rated: rated.length,
    testSize,
    relevant: 0,
    likedPoint,
    draws: 0,
    neutral: null,
    lift: null,
    tuned: null,
    within: null,
    pool: null,
    groups: null,
    neutralAvailable: neutral.length,
  };
  if (rated.length < MIN_RATED) return result;

  const useNeutral = neutral.length >= MIN_NEUTRAL;
  const grid = weightGrid();
  const gridTotals = new Float64Array(grid.length);
  const totals = { neutral: new Totals(), within: new Totals(), pool: new Totals() };
  totals.neutral.candidates = Math.min(POOL_SAMPLE, neutral.length);
  totals.pool.candidates = Math.min(POOL_SAMPLE, unrated.length);
  const means = { liked: new Means(), other: new Means(), neutral: new Means(), pool: new Means() };
  const fresh: Scored[][] = [];
  let relevantTotal = 0;
  const precisionOf = (list: Scored[], value: (item: Scored) => number) =>
    measure(list.map((item) => ({ key: item.key, liked: item.liked, value: value(item) }))).precision;

  for (let draw = 0; draw < draws * 2; draw++) {
    const random = seededRandom(seed * 100 + draw);
    const test = sample(rated, testSize, random);
    const profile = buildProfile(input.library, mode, ctx.space, input.now, new Set(test.map((title) => title.key as string)), input.feedback[mode]);
    const cfIndex = buildCfIndex(profile, input.features, input.now);
    const score = (key: string, liked: boolean): Scored => ({
      key,
      liked,
      components: componentScores(ctx, profile, cfIndex, input.features.get(key)!, 'tmdb').components,
    });
    const hiddenRaw = test.map((title) => score(title.key as string, (explicitRating(title, mode)?.score ?? 0) >= likedPoint));
    const hidden = rankWithin(hiddenRaw);
    const neutralList = useNeutral ? rankWithin([...hiddenRaw, ...sample(neutral, POOL_SAMPLE, random).map((key) => score(key, false))]) : [];

    // The second ten draws only test the best balance found on the first ten.
    if (draw >= draws) {
      if (useNeutral) fresh.push(neutralList);
      continue;
    }

    relevantTotal += hidden.filter((item) => item.liked).length;
    totals.within.add(hidden, weights);
    means.liked.add(hiddenRaw.filter((item) => item.liked));
    means.other.add(hiddenRaw.filter((item) => !item.liked));
    if (useNeutral) {
      totals.neutral.add(neutralList, weights);
      means.neutral.add(neutralList.slice(hidden.length));
      grid.forEach((balance, index) => {
        gridTotals[index] += precisionOf(neutralList, (item) => blend(item.ranked ?? item.components, balance)?.score ?? 0);
      });
    }
    if (unrated.length > 0) {
      const candidates = sample(unrated, POOL_SAMPLE, random).map((key) => score(key, false));
      totals.pool.add(rankWithin([...hiddenRaw, ...candidates]), weights);
      means.pool.add(candidates);
    }
  }

  result.draws = draws;
  result.relevant = relevantTotal / draws;
  result.within = totals.within.result();
  result.pool = totals.pool.result();
  result.groups = { liked: means.liked.result(draws), other: means.other.result(draws), neutral: means.neutral.result(draws), pool: means.pool.result(draws) };
  if (!useNeutral) return result;

  result.neutral = totals.neutral.result();
  result.lift = result.neutral!.measures.model.precision - result.neutral!.measures.baseline.precision;

  // The best balance on the first draws; a tie goes to the one closest to the current weights.
  const distance = (balance: Weights) =>
    Math.abs(balance.content - weights.content) + Math.abs(balance.collaborative - weights.collaborative) + Math.abs(balance.quality - weights.quality);
  let best = 0;
  grid.forEach((balance, index) => {
    const gap = gridTotals[index] - gridTotals[best];
    if (gap > 1e-9 || (Math.abs(gap) <= 1e-9 && distance(balance) < distance(grid[best]))) best = index;
  });
  const freshPrecision = (value: (item: Scored) => number) => fresh.reduce((sum, list) => sum + precisionOf(list, value), 0) / fresh.length;
  const freshModel = freshPrecision((item) => blend(item.ranked ?? item.components, grid[best])?.score ?? 0);
  const freshBaseline = freshPrecision((item) => valueOf('baseline', item, weights));
  result.tuned = { weights: grid[best], train: gridTotals[best] / draws, fresh: freshModel, freshBaseline, freshLift: freshModel - freshBaseline };
  return result;
}

export function runBacktest(input: RecInput, seed: number, draws = DRAWS): ModeBacktest[] {
  const ctx = createContext(input);
  return MODES.map((mode) => backtestMode(ctx, mode, seed, draws));
}
