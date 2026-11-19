// Taste profiles: each rater's reference points, the ratings and implicit
// signals that train the profile, and the taste centroid built from them.
// Pure, unit tested.

import type { ProfileId } from '../types';
import type { LibraryTitle, Mode } from './types';
import { addScaled, denseNorm, type VectorSpace } from './vectors';

const YEAR_MS = 365.25 * 86_400_000;

export interface ReferencePoints {
  /** The lowest score that at most 35% of ratings reach. */
  liked: number;
  /** The median. */
  neutral: number;
  /** The highest score that at most 30% of ratings sit at or below. */
  disliked: number;
}

/** Used until a rater has any ratings: the household's own points from the spec. */
export const DEFAULT_POINTS: ReferencePoints = { liked: 9, neutral: 8, disliked: 7.5 };

const HALF_POINTS = Array.from({ length: 19 }, (_, index) => 1 + index / 2);
const roundHalf = (value: number) => Math.round(value * 2) / 2;

export function referencePoints(scores: number[]): ReferencePoints {
  if (scores.length === 0) return DEFAULT_POINTS;
  const n = scores.length;
  const share = (test: (score: number) => boolean) => scores.filter(test).length / n;
  const liked = HALF_POINTS.find((point) => share((score) => score >= point) <= 0.35) ?? 10;
  const disliked = [...HALF_POINTS].reverse().find((point) => share((score) => score <= point) <= 0.3) ?? 1;
  const sorted = [...scores].sort((a, b) => a - b);
  const middle = Math.floor(n / 2);
  const neutral = roundHalf(n % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
  return { liked, neutral, disliked };
}

export const peopleIn = (mode: Mode): ProfileId[] => (mode === 'US' ? ['A', 'B'] : [mode]);
const bit = (person: ProfileId) => (person === 'A' ? 1 : 2);
const includes = (participants: number, person: ProfileId) => (participants & bit(person)) !== 0;

/** The rating that counts for a mode: Together uses only agreed ratings; a person uses their own, else the agreed one. */
export function explicitRating(title: LibraryTitle, mode: Mode): { score: number; at: number } | undefined {
  return mode === 'US' ? title.ratings.US : (title.ratings[mode] ?? title.ratings.US);
}

/** Whether a person has watched (or started) a title. An agreed rating means both watched it. */
export function hasSeen(title: LibraryTitle, person: ProfileId): boolean {
  if (title.ratings[person] != null || title.ratings.US != null) return true;
  const status = title.states[person]?.status;
  if (status === 'watched' || status === 'watching' || status === 'dropped') return true;
  return title.events.some((event) => includes(event.participants, person));
}

export interface TrainingEntry {
  key: string;
  titleId: string;
  name: string;
  /** On the rater's rating scale. */
  value: number;
  /** 1 for a rating; 0.5 for an implicit signal; 0.25 for a watchlist add. */
  weight: number;
  at: number;
  explicit: boolean;
}

/** An implicit signal placed on the rater's scale (spec, section 4), or undefined. */
export function implicitSignal(
  title: LibraryTitle,
  mode: Mode,
  points: ReferencePoints,
): { value: number; weight: number; at: number } | undefined {
  const middle = (points.neutral + points.liked) / 2;
  const latest = Math.max(0, ...title.events.map((event) => event.at), ...Object.values(title.states).map((state) => state?.at ?? 0));
  const signal = (value: number, weight = 0.5) => ({ value, weight, at: latest });

  if (mode !== 'US') {
    const state = title.states[mode];
    const mine = title.events.filter((event) => includes(event.participants, mode));
    if (state?.rewatch || mine.some((event) => event.isRewatch)) return signal(points.liked);
    if (state?.status === 'not_interested') return signal(points.disliked - 1);
    if (state?.status === 'dropped') return signal(points.disliked);
    const finished = mine.some((event) => event.completion >= 1);
    if (mine.length > 0 && !finished) return signal(points.disliked - 1);
    if (finished || state?.status === 'watched') return signal(points.neutral);
    if (state?.status === 'watchlist') return signal(middle, 0.25);
    return undefined;
  }

  const a = title.states.A;
  const b = title.states.B;
  const together = title.events.filter((event) => event.participants === 3);
  if ((a?.rewatch && b?.rewatch) || together.some((event) => event.isRewatch)) return signal(points.liked);
  if (a?.status === 'not_interested' || b?.status === 'not_interested') return signal(points.disliked - 1);
  if (a?.status === 'dropped' || b?.status === 'dropped') return signal(points.disliked);
  const finished = together.some((event) => event.completion >= 1);
  if (together.length > 0 && !finished) return signal(points.disliked - 1);
  if (finished) return signal(points.neutral);
  if (a?.status === 'watchlist' && b?.status === 'watchlist') return signal(middle, 0.25);
  return undefined;
}

export interface Profile {
  mode: Mode;
  points: ReferencePoints;
  mean: number;
  sd: number;
  entries: TrainingEntry[];
  /** Number of explicit ratings behind the profile. */
  ratings: number;
  centroid: Float64Array;
  /** Length of the centroid; 0 when there is nothing to learn from. */
  norm: number;
  /** Entries at or above the liked point, best first: they seed reasons and the collaborative signal. */
  liked: TrainingEntry[];
}

/**
 * Builds a rater's profile from their ratings and implicit signals.
 * holdOut removes titles (by key) as if never rated: the backtest's test set.
 */
export function buildProfile(
  library: LibraryTitle[],
  mode: Mode,
  space: VectorSpace,
  now: number,
  holdOut: Set<string> = new Set(),
): Profile {
  // Titles saved by name only still count toward the rater's scale.
  const known = library.filter((title) => !(title.key && holdOut.has(title.key)));
  const explicitScores = known.map((title) => explicitRating(title, mode)).filter((rating) => rating != null);
  const points = referencePoints(explicitScores.map((rating) => rating.score));

  const entries: TrainingEntry[] = [];
  for (const title of known) {
    if (!title.key) continue;
    const key = title.key;
    const rating = explicitRating(title, mode);
    if (rating) {
      entries.push({ key, titleId: title.id, name: title.name, value: rating.score, weight: 1, at: rating.at, explicit: true });
      continue;
    }
    const signal = implicitSignal(title, mode, points);
    if (signal) entries.push({ key, titleId: title.id, name: title.name, ...signal, explicit: false });
  }

  const values = explicitScores.map((rating) => rating.score);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : points.neutral;
  const variance = values.length ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length : 1;
  const sd = Math.max(0.5, Math.sqrt(variance));

  const centroid = new Float64Array(space.dimension);
  for (const entry of entries) {
    const vector = space.vector(entry.key);
    if (!vector) continue;
    const ageYears = Math.max(0, (now - entry.at) / YEAR_MS);
    const decay = 0.5 ** (ageYears / 4);
    addScaled(centroid, vector, decay * entry.weight * ((entry.value - mean) / sd));
  }

  const liked = entries
    .filter((entry) => entry.value >= points.liked)
    .sort((a, b) => b.value - a.value || Number(b.explicit) - Number(a.explicit) || b.at - a.at);

  return { mode, points, mean, sd, entries, ratings: values.length, centroid, norm: denseNorm(centroid), liked };
}
