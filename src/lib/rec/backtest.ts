// The backtest (spec, section 4, metrics): hide a random 20% of a rater's
// ratings, rebuild the model without them, and see whether the hidden titles
// the rater liked rank near the top of a list that also holds 200 unrated pool
// titles. The same list ranked by the quality component alone is the baseline.
// Pure, unit tested.
//
// One draw of 20% holds about 30 titles, about 9 of them liked, so precision@10
// moves in steps of 0.1. The check repeats the draw with 10 seeds (the month's
// seed first) and reports the mean, so the 0.05 gate is not decided by luck.
// Quality comes from TMDB scores alone here (see componentScores).

import { buildProfile, explicitRating, referencePoints } from './profile';
import { sample, seededRandom } from './random';
import { blend, buildCfIndex, collaborative, QUALITY_PRIOR, type CfEntry } from './score';
import { activeWeights, componentScores, createContext, type Context } from './engine';
import type { Profile } from './profile';
import { MODES, type Mode, type RecInput } from './types';

export const TEST_SHARE = 0.2;
export const POOL_SAMPLE = 200;
export const DRAWS = 10;
export const TOP_N = 10;
/** Fewer rated titles than this, and the check says so instead of reporting noise. */
export const MIN_RATED = 25;

export type Variant = 'model' | 'baseline' | 'content' | 'collaborative' | 'cfZero';
export const VARIANTS: Variant[] = ['model', 'baseline', 'content', 'collaborative', 'cfZero'];

export interface Measure {
  precision: number;
  recall: number;
}

export interface ModeBacktest {
  mode: Mode;
  /** Rated titles with TMDB details: what the test draws from. */
  rated: number;
  testSize: number;
  /** Mean number of liked titles in a draw's test set. */
  relevant: number;
  poolSample: number;
  likedPoint: number;
  draws: number;
  results: Record<Variant, Measure> | null;
  /** model precision@10 minus baseline precision@10. */
  lift: number | null;
}

function score(variant: Variant, ctx: Context, profile: Profile, cfIndex: Map<string, CfEntry>, key: string): number {
  const feature = ctx.input.features.get(key);
  if (!feature) return 0;
  const missing = componentScores(ctx, profile, cfIndex, feature, 'missing', 'tmdb');
  switch (variant) {
    case 'model':
      return blend(missing.components, activeWeights(ctx.input.weights))?.score ?? 0;
    case 'baseline':
      return missing.components.quality ?? QUALITY_PRIOR / 10;
    case 'content':
      return missing.components.content ?? 0.5;
    case 'collaborative':
      return collaborative(missing.cf, 'zero') ?? 0;
    case 'cfZero':
      return blend(componentScores(ctx, profile, cfIndex, feature, 'zero', 'tmdb').components, activeWeights(ctx.input.weights))?.score ?? 0;
  }
}

export function backtestMode(ctx: Context, mode: Mode, seed: number, draws = DRAWS): ModeBacktest {
  const { input } = ctx;
  const rated = input.library.filter((title) => title.key && input.features.has(title.key) && explicitRating(title, mode));
  const libraryKeys = new Set(input.library.map((title) => title.key).filter(Boolean));
  const unrated = [...input.pool.keys()].filter((key) => !libraryKeys.has(key) && input.features.has(key)).sort();
  const likedPoint = referencePoints(input.library.map((title) => explicitRating(title, mode)?.score).filter((value) => value != null)).liked;
  const testSize = Math.max(1, Math.round(rated.length * TEST_SHARE));
  const poolSample = Math.min(POOL_SAMPLE, unrated.length);
  const empty: ModeBacktest = { mode, rated: rated.length, testSize, relevant: 0, poolSample, likedPoint, draws: 0, results: null, lift: null };
  if (rated.length < MIN_RATED || poolSample === 0) return empty;

  const totals = Object.fromEntries(VARIANTS.map((variant) => [variant, { precision: 0, recall: 0, recallDraws: 0 }])) as Record<
    Variant,
    { precision: number; recall: number; recallDraws: number }
  >;
  let relevantTotal = 0;
  for (let draw = 0; draw < draws; draw++) {
    const random = seededRandom(seed * 100 + draw);
    const test = sample(rated, testSize, random);
    const listed = [...test.map((title) => title.key as string), ...sample(unrated, poolSample, random)];
    const relevant = new Set(test.filter((title) => (explicitRating(title, mode)?.score ?? 0) >= likedPoint).map((title) => title.key as string));
    relevantTotal += relevant.size;

    const profile = buildProfile(input.library, mode, ctx.space, input.now, new Set(test.map((title) => title.key as string)));
    const cfIndex = buildCfIndex(profile.liked, input.features);
    for (const variant of VARIANTS) {
      const top = listed
        .map((key) => ({ key, value: score(variant, ctx, profile, cfIndex, key) }))
        .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
        .slice(0, TOP_N);
      const hits = top.filter((entry) => relevant.has(entry.key)).length;
      totals[variant].precision += hits / TOP_N;
      if (relevant.size > 0) {
        totals[variant].recall += hits / Math.min(TOP_N, relevant.size);
        totals[variant].recallDraws++;
      }
    }
  }

  const results = Object.fromEntries(
    VARIANTS.map((variant) => [
      variant,
      { precision: totals[variant].precision / draws, recall: totals[variant].recallDraws ? totals[variant].recall / totals[variant].recallDraws : 0 },
    ]),
  ) as Record<Variant, Measure>;
  return {
    mode,
    rated: rated.length,
    testSize,
    relevant: relevantTotal / draws,
    poolSample,
    likedPoint,
    draws,
    results,
    lift: results.model.precision - results.baseline.precision,
  };
}

export function runBacktest(input: RecInput, seed: number, draws = DRAWS): ModeBacktest[] {
  const ctx = createContext(input);
  return MODES.map((mode) => backtestMode(ctx, mode, seed, draws));
}
