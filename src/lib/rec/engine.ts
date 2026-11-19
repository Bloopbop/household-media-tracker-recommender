// Builds a slate of picks for each mode (spec, section 3, steps 2 to 7):
// filter per mode, score the four components, adjust for availability,
// diversify, fill the exploratory slots and explain each pick. Pure, unit
// tested; the caller loads the data and saves the result.

import type { ProfileId } from '../types';
import type { FeatureRow } from './features';
import { buildProfile, explicitRating, hasSeen, peopleIn, type Profile } from './profile';
import { reasonFor } from './reasons';
import {
  availability,
  blend,
  buildCfIndex,
  collaborative,
  externalScores,
  quality,
  QUALITY_PRIOR,
  type CfEntry,
  type CfMode,
  type ExternalScores,
} from './score';
import { MODES, type Components, type Eligibility, type LibraryTitle, type Mode, type RecInput, type SlatePick, type SlateResult, type Weights } from './types';
import { dot, dotDense, VectorSpace } from './vectors';

/** Changes whenever scoring changes, so saved slates are rebuilt. */
export const MODEL_VERSION = 'p2.1';
export const SLATE_SIZE = 20;
/** Positions (1-based) held for exploratory picks. */
export const EXPLORATORY_POSITIONS = [5, 10, 15, 20];
export const RESERVE_SIZE = 20;
const MMR_LAMBDA = 0.7;
const MMR_TOP = 100;
const MAX_PER_FRANCHISE = 2;
const MAX_PER_GENRE = 8;
const MAX_REWATCH = 2;
const EXPLORE_MIN_CONTENT = 0.6;
const COLD_IMDB_VOTES = 1000;
export const COLD_PROFILE_RATINGS = 30;
export const TOP_CANDIDATES = 300;

export interface Context {
  input: RecInput;
  space: VectorSpace;
  /** Library titles by key. */
  library: Map<string, LibraryTitle>;
}

export function createContext(input: RecInput): Context {
  const library = new Map<string, LibraryTitle>();
  for (const title of input.library) if (title.key) library.set(title.key, title);
  return { input, space: new VectorSpace(input.features.values()), library };
}

/** The partner component waits for stage 2: 30 ratings of each person's own (spec, trigger 7). */
export const activeWeights = (weights: Weights): Weights => ({ ...weights, partner: 0 });

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Whether, and how, a library title may be shown in a mode (spec: household aggregation). */
export function eligibility(title: LibraryTitle, mode: Mode): Eligibility {
  const people = peopleIn(mode);
  const statuses = people.map((person) => title.states[person]?.status);
  // Dropped or not interested is a veto; a series in progress belongs to the Continue row.
  if (statuses.some((status) => status === 'not_interested' || status === 'dropped' || status === 'watching')) {
    return { type: 'excluded' };
  }
  const seen = people.filter((person) => hasSeen(title, person));
  if (seen.length === 0) return { type: 'new' };
  if (!seen.every((person) => title.states[person]?.rewatch)) return { type: 'excluded' };
  const own = (person: ProfileId) => (title.ratings[person] ?? title.ratings.US)?.score;
  const score =
    mode !== 'US'
      ? explicitRating(title, mode)?.score
      : seen.length === 2
        ? (title.ratings.US?.score ?? own('A') ?? own('B'))
        : own(seen[0]);
  return { type: 'rewatch', score: score ?? 8, seenBy: seen };
}

export interface ComponentScores {
  components: Components;
  cf: CfEntry | undefined;
  external: ExternalScores;
}

/**
 * The four components for one title. qualityFrom 'tmdb' leaves out the OMDb
 * scores: the backtest uses it, because every library title has OMDb scores
 * and most pool titles do not, which would tilt both rankings toward the
 * library titles.
 */
export function componentScores(
  ctx: Context,
  profile: Profile,
  cfIndex: Map<string, CfEntry>,
  feature: FeatureRow,
  cfMode: CfMode = 'missing',
  qualityFrom: 'all' | 'tmdb' = 'all',
): ComponentScores {
  const vector = ctx.space.vector(feature.key);
  const content = vector && profile.norm > 0 ? (1 + dotDense(vector, profile.centroid) / profile.norm) / 2 : undefined;
  const cf = cfIndex.get(feature.key);
  const external = externalScores(feature, qualityFrom === 'all' ? ctx.input.omdb.get(feature.key) : undefined);
  return { components: { content, collaborative: collaborative(cf, cfMode), quality: quality(external) }, cf, external };
}

interface Scored extends ComponentScores {
  feature: FeatureRow;
  titleId: string | null;
  score: number;
  contributions: Components;
  weights: Components;
  cold: boolean;
  rewatch: ProfileId[] | null;
  availability: { factor: number; label: string };
  /** The score used for ranking: blend (or exploratory score, or real rating) times availability. */
  final: number;
}

/** The genres the viewer watches most: the top `count` by how many of their titles carry each. */
function usualGenres(profile: Profile, features: Map<string, FeatureRow>, count: number): Set<string> {
  const seen = new Map<string, number>();
  for (const entry of profile.entries) {
    for (const genre of features.get(entry.key)?.genres ?? []) seen.set(genre, (seen.get(genre) ?? 0) + 1);
  }
  return new Set([...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([genre]) => genre));
}

/** Genres whose titles the viewer rates, on average, at or below their disliked point. */
function dislikedGenres(profile: Profile, features: Map<string, FeatureRow>): Set<string> {
  const totals = new Map<string, { sum: number; n: number }>();
  for (const entry of profile.entries) {
    if (!entry.explicit) continue;
    for (const genre of features.get(entry.key)?.genres ?? []) {
      const total = totals.get(genre) ?? { sum: 0, n: 0 };
      total.sum += entry.value;
      total.n++;
      totals.set(genre, total);
    }
  }
  return new Set([...totals.entries()].filter(([, total]) => total.sum / total.n <= profile.points.disliked).map(([genre]) => genre));
}

class Caps {
  private franchise = new Map<number, number>();
  private genre = new Map<string, number>();
  private rewatches = 0;
  /** Set when too few titles fit: the genre cap gives way so the slate can still fill. */
  relaxGenre = false;

  fits(item: Scored): boolean {
    const collection = item.feature.collection;
    if (collection != null && (this.franchise.get(collection) ?? 0) >= MAX_PER_FRANCHISE) return false;
    const genre = item.feature.genres[0];
    if (!this.relaxGenre && genre && (this.genre.get(genre) ?? 0) >= MAX_PER_GENRE) return false;
    return !(item.rewatch && this.rewatches >= MAX_REWATCH);
  }

  add(item: Scored): void {
    const collection = item.feature.collection;
    if (collection != null) this.franchise.set(collection, (this.franchise.get(collection) ?? 0) + 1);
    const genre = item.feature.genres[0];
    if (genre) this.genre.set(genre, (this.genre.get(genre) ?? 0) + 1);
    if (item.rewatch) this.rewatches++;
  }
}

function scoreAll(ctx: Context, mode: Mode, profile: Profile): { ranked: Scored[]; cold: Scored[]; cfIndex: Map<string, CfEntry> } {
  const { input } = ctx;
  const cfIndex = buildCfIndex(profile.liked, input.features);
  const weights = activeWeights(input.weights);
  const services = input.services ? new Set(input.services) : null;
  const ranked: Scored[] = [];
  const cold: Scored[] = [];

  for (const key of new Set([...input.pool.keys(), ...ctx.library.keys()])) {
    const feature = input.features.get(key);
    if (!feature) continue;
    const title = ctx.library.get(key);
    const allowed: Eligibility = title ? eligibility(title, mode) : { type: 'new' };
    if (allowed.type === 'excluded') continue;
    const scores = componentScores(ctx, profile, cfIndex, feature);
    const mixed = blend(scores.components, weights);
    if (!mixed) continue;
    const offer = availability(feature.offers, input.region, services);
    const isRewatch = allowed.type === 'rewatch';
    const omdb = input.omdb.get(key);
    const isCold = !isRewatch && !scores.cf && (!omdb || (omdb.imdbVotes ?? 0) < COLD_IMDB_VOTES);
    const base = isRewatch
      ? clamp01((allowed.score - 1) / 9)
      : isCold
        ? 0.7 * (scores.components.content ?? 0.5) + 0.3 * (scores.components.quality ?? QUALITY_PRIOR / 10)
        : mixed.score;
    const item: Scored = {
      ...scores,
      feature,
      titleId: title?.id ?? null,
      score: base,
      contributions: mixed.contributions,
      weights: mixed.weights,
      cold: isCold,
      rewatch: isRewatch ? allowed.seenBy : null,
      availability: offer,
      final: base * offer.factor,
    };
    (isCold ? cold : ranked).push(item);
  }
  const order = (a: Scored, b: Scored) => b.final - a.final || a.feature.key.localeCompare(b.feature.key);
  ranked.sort(order);
  cold.sort(order);
  return { ranked, cold, cfIndex };
}

export function buildSlate(ctx: Context, mode: Mode): SlateResult {
  const { input, space } = ctx;
  const profile = buildProfile(input.library, mode, space, input.now);
  const { ranked, cold, cfIndex } = scoreAll(ctx, mode, profile);
  const similarity = (a: Scored, b: Scored) => {
    const va = space.vector(a.feature.key);
    const vb = space.vector(b.feature.key);
    return va && vb ? dot(va, vb) : 0;
  };

  // Ranked picks: maximal marginal relevance over the top 100, within the caps.
  const caps = new Caps();
  const chosen: Scored[] = [];
  const remaining = ranked.slice(0, MMR_TOP);
  const pickRanked = (count: number) => {
    for (let added = 0; added < count && remaining.length > 0; added++) {
      let best = -1;
      let bestValue = -Infinity;
      remaining.forEach((item, index) => {
        if (!caps.fits(item)) return;
        const penalty = chosen.length ? Math.max(...chosen.map((other) => similarity(item, other))) : 0;
        const value = MMR_LAMBDA * item.final - (1 - MMR_LAMBDA) * penalty;
        if (value > bestValue) {
          bestValue = value;
          best = index;
        }
      });
      if (best < 0) return;
      const [item] = remaining.splice(best, 1);
      chosen.push(item);
      caps.add(item);
    }
  };
  pickRanked(SLATE_SIZE - EXPLORATORY_POSITIONS.length);

  // Exploratory picks: cold titles that match the taste; then well-reviewed
  // titles from genres outside the viewer's top five.
  const exploratory: { item: Scored; kind: 'cold' | 'outside' }[] = [];
  const pickCold = () => {
    for (const item of cold) {
      if (exploratory.length >= EXPLORATORY_POSITIONS.length) break;
      if (exploratory.some((entry) => entry.item === item)) continue;
      if ((item.components.content ?? 0) >= EXPLORE_MIN_CONTENT && caps.fits(item)) {
        exploratory.push({ item, kind: 'cold' });
        caps.add(item);
      }
    }
  };
  pickCold();
  if (exploratory.length < EXPLORATORY_POSITIONS.length) {
    // Outside the five genres the viewer watches most, and not one they rate poorly.
    const usual = usualGenres(profile, input.features, 5);
    const disliked = dislikedGenres(profile, input.features);
    const used = new Set([...chosen, ...exploratory.map((entry) => entry.item)].map((item) => item.feature.key));
    const outside = [...ranked, ...cold]
      .filter((item) => !used.has(item.feature.key) && !item.rewatch && item.components.quality != null)
      .filter((item) => item.feature.genres.length > 0 && !usual.has(item.feature.genres[0]) && !disliked.has(item.feature.genres[0]))
      .sort((a, b) => (b.components.quality ?? 0) * b.availability.factor - (a.components.quality ?? 0) * a.availability.factor);
    for (const item of outside) {
      if (exploratory.length >= EXPLORATORY_POSITIONS.length) break;
      if (caps.fits(item)) {
        exploratory.push({ item, kind: 'outside' });
        caps.add(item);
      }
    }
  }

  // Exploratory slots nobody could fill go to ranked picks.
  pickRanked(EXPLORATORY_POSITIONS.length - exploratory.length);

  // Still short: let the genre cap give way rather than show fewer picks.
  if (chosen.length + exploratory.length < SLATE_SIZE) {
    caps.relaxGenre = true;
    pickCold();
    pickRanked(SLATE_SIZE - chosen.length - exploratory.length);
  }

  // Interleave: exploratory picks at positions 5, 10, 15 and 20.
  const visible: { item: Scored; exploratory: 'cold' | 'outside' | null }[] = [];
  let r = 0;
  let e = 0;
  for (let position = 1; position <= SLATE_SIZE; position++) {
    if (EXPLORATORY_POSITIONS.includes(position) && e < exploratory.length) {
      visible.push({ item: exploratory[e].item, exploratory: exploratory[e++].kind });
    } else if (r < chosen.length) visible.push({ item: chosen[r++], exploratory: null });
    else if (e < exploratory.length) visible.push({ item: exploratory[e].item, exploratory: exploratory[e++].kind });
  }

  const shown = new Set(visible.map((entry) => entry.item.feature.key));
  const reserve = ranked.filter((item) => !shown.has(item.feature.key)).slice(0, RESERVE_SIZE);

  const cited = new Map<string, number>();
  const toPick = (item: Scored, kind: 'cold' | 'outside' | null): SlatePick => {
    const reason = reasonFor({
      cited,
      mode,
      names: input.names,
      key: item.feature.key,
      feature: item.feature,
      space,
      profile,
      contributions: item.contributions,
      cf: cfIndex.get(item.feature.key),
      external: item.external,
      exploratory: kind,
      rewatch: item.rewatch,
    });
    return {
      key: item.feature.key,
      titleId: item.titleId,
      kind: item.feature.kind,
      name: item.feature.name,
      year: item.feature.year,
      posterPath: item.feature.posterPath,
      score: item.final,
      components: item.components,
      availability: item.availability.factor,
      exploratory: kind !== null,
      rewatch: item.rewatch !== null,
      reason: reason.text,
      evidence: {
        seeds: reason.seeds,
        recommendedBy: reason.recommendedBy,
        external: item.external,
        availability: item.availability,
        contributions: item.contributions,
        weights: item.weights,
        template: reason.template,
        ...(item.rewatch ? { seenBy: item.rewatch } : {}),
      },
    };
  };

  const topCandidates = [...ranked, ...cold]
    .filter((item) => !item.titleId)
    .sort((a, b) => b.final - a.final)
    .slice(0, TOP_CANDIDATES)
    .map((item) => item.feature.key);

  return {
    mode,
    picks: visible.map((entry) => toPick(entry.item, entry.exploratory)),
    reserve: reserve.map((item) => toPick(item, null)),
    stats: {
      candidates: ranked.length + cold.length,
      ratings: profile.ratings,
      coldProfile: profile.ratings < COLD_PROFILE_RATINGS,
      topCandidates,
    },
  };
}

export function buildSlates(input: RecInput): SlateResult[] {
  const ctx = createContext(input);
  return MODES.map((mode) => buildSlate(ctx, mode));
}
