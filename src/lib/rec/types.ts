// Types shared by the recommender's pure modules. Nothing here touches the
// database or the network.

import type { Kind, OmdbScores, ProfileId, Rater, Status } from '../types';
import type { FeatureRow } from './features';

/** A recommendation mode: one person, or 'US' for the two of you together. */
export type Mode = Rater;
export const MODES: Mode[] = ['A', 'B', 'US'];

export interface Weights {
  content: number;
  collaborative: number;
  quality: number;
  partner: number;
}

/** The spec's starting weights. Partner stays off until each person has 30 ratings of their own. */
export const START_WEIGHTS: Weights = { content: 0.45, collaborative: 0.3, quality: 0.2, partner: 0.05 };

/**
 * Pool sources chosen without the household's taste. A title from any of them
 * is a fair title to rank the household's favourites against, and the pool
 * keeps them all whatever its size.
 */
export const NEUTRAL_SOURCES: ReadonlySet<string> = new Set(['trending', 'popular', 'services']);
export const isNeutral = (sources: readonly string[]) => sources.some((source) => NEUTRAL_SOURCES.has(source));

export type ComponentName = keyof Weights;
export type Components = Partial<Record<ComponentName, number>>;

/** One library title with everything the household recorded about it. */
export interface LibraryTitle {
  id: string;
  /** kind:tmdbId once matched to TMDB; null for titles saved by name only. */
  key: string | null;
  kind: Kind;
  name: string;
  ratings: Partial<Record<Rater, { score: number; at: number }>>;
  states: Partial<Record<ProfileId, { status: Status | null; rewatch: boolean; at: number }>>;
  events: { participants: number; completion: number; isRewatch: boolean; at: number }[];
}

/** How a candidate may be shown in a mode. */
export type Eligibility =
  | { type: 'new' }
  /** Seen already, and flagged would-rewatch by whoever saw it. score is the real rating. */
  | { type: 'rewatch'; score: number; seenBy: ProfileId[] }
  | { type: 'excluded' };

/** What the household's reactions say about titles in one mode. */
export interface ModeFeedback {
  /** Kept out of this mode's slates: Not tonight for 14 days, a fatigue rest, Together's Not interested. */
  hidden: Set<string>;
  /**
   * Implicit signals for titles without a rating in this mode: three Not
   * tonights count as disliked; Together's Not interested as one point below.
   */
  implicit: Map<string, { kind: 'skipped' | 'not_interested'; at: number }>;
}

export const noFeedback = (): Record<Mode, ModeFeedback> => ({
  A: { hidden: new Set(), implicit: new Map() },
  B: { hidden: new Set(), implicit: new Map() },
  US: { hidden: new Set(), implicit: new Map() },
});

export interface RecInput {
  now: number;
  library: LibraryTitle[];
  /** Feature rows for library titles and candidates, by key. */
  features: Map<string, FeatureRow>;
  /** OMDb scores, by title key. */
  omdb: Map<string, OmdbScores>;
  /** Candidate keys from the pool, with where each came from. */
  pool: Map<string, string[]>;
  region: string;
  /** Provider ids the household subscribes to in the region, or null if not set. */
  services: number[] | null;
  names: { A: string; B: string };
  weights: Weights;
  feedback: Record<Mode, ModeFeedback>;
}

export interface Evidence {
  /** Liked titles most like this one, with the rater's rating. */
  seeds: { name: string; rating: number; features: string[] }[];
  /** Liked titles whose TMDB recommendations list this one. */
  recommendedBy: string[];
  external: { imdb: number | null; imdbVotes: number | null; rt: number | null; mc: number | null; tmdb: number | null; tmdbVotes: number };
  availability: { factor: number; label: string };
  /** The part of the score each component contributed, after weighting. */
  contributions: Components;
  /** The weights in force for this title (missing components removed). */
  weights: Components;
  template: string;
  seenBy?: ProfileId[];
}

/**
 * Which ranking placed a pick. Each slate's ranked places alternate between
 * the recommender ('model') and review scores alone ('reviews'), unlabelled,
 * so the household's reactions show which finds more they want to watch.
 * Exploratory picks are 'explore' and count for neither.
 */
export type Arm = 'model' | 'reviews' | 'explore';

export interface SlatePick {
  key: string;
  arm: Arm;
  titleId: string | null;
  kind: Kind;
  name: string;
  year: number | null;
  posterPath: string | null;
  score: number;
  components: Components;
  availability: number;
  exploratory: boolean;
  rewatch: boolean;
  reason: string;
  evidence: Evidence;
}

export interface SlateResult {
  mode: Mode;
  /** The visible picks, in order: 16 ranked and 4 exploratory at 5, 10, 15 and 20. */
  picks: SlatePick[];
  /**
   * The next picks, to refill the slate when one leaves: ranked ones continue
   * the same alternation, exploratory ones refill exploratory places.
   */
  reserve: SlatePick[];
  stats: {
    candidates: number;
    ratings: number;
    coldProfile: boolean;
    /** The 300 best-scoring candidates outside the library, for OMDb lookups. */
    topCandidates: string[];
  };
}

export type { OmdbScores };
