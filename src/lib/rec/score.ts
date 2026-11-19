// The score components and how they combine (spec, section 3). Every
// component is scaled 0 to 1; a missing one gives its weight to the others in
// proportion. Pure, unit tested.

import type { OmdbScores } from '../types';
import type { FeatureRow, Offers } from './features';
import type { TrainingEntry } from './profile';
import type { ComponentName, Components, Weights } from './types';

export const COMPONENT_NAMES: ComponentName[] = ['content', 'collaborative', 'quality', 'partner'];

// ------------------------------------------------------------------ quality

/** Scores with few votes are pulled toward this, on a 10-point scale. */
export const QUALITY_PRIOR = 6.8;
const IMDB_PRIOR_VOTES = 2500;
const TMDB_PRIOR_VOTES = 300;

export interface ExternalScores {
  imdb: number | null;
  imdbVotes: number | null;
  rt: number | null;
  mc: number | null;
  tmdb: number | null;
  tmdbVotes: number;
}

export function externalScores(feature: FeatureRow, omdb: OmdbScores | undefined): ExternalScores {
  return {
    imdb: omdb?.imdbRating ?? null,
    imdbVotes: omdb?.imdbVotes ?? null,
    rt: omdb?.rottenTomatoes ?? null,
    mc: omdb?.metacritic ?? null,
    tmdb: feature.tmdbVote,
    tmdbVotes: feature.tmdbVotes,
  };
}

const shrink = (value: number, votes: number, weight: number) => (votes * value + weight * QUALITY_PRIOR) / (votes + weight);

/** Mean of IMDb, Rotten Tomatoes, Metacritic and TMDB, the two audience scores shrunk toward the prior when votes are few. */
export function quality(scores: ExternalScores): number | undefined {
  const parts: number[] = [];
  if (scores.imdb != null) parts.push(shrink(scores.imdb, scores.imdbVotes ?? 1000, IMDB_PRIOR_VOTES) / 10);
  if (scores.rt != null) parts.push(scores.rt / 100);
  if (scores.mc != null) parts.push(scores.mc / 100);
  if (scores.tmdb != null && scores.tmdbVotes > 0) parts.push(shrink(scores.tmdb, scores.tmdbVotes, TMDB_PRIOR_VOTES) / 10);
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) / parts.length : undefined;
}

// ------------------------------------------------------------ collaborative

export interface CfEntry {
  /** Sum over liked titles of how high this title sits in their TMDB recommendations (1 at the top). */
  sum: number;
  by: { name: string; strength: number }[];
}

/** For every title any liked title recommends: how strongly, and by which liked titles. */
export function buildCfIndex(liked: TrainingEntry[], features: Map<string, FeatureRow>): Map<string, CfEntry> {
  const index = new Map<string, CfEntry>();
  for (const seed of liked) {
    const recs = features.get(seed.key)?.recs ?? [];
    recs.forEach((key, position) => {
      const strength = 1 - position / recs.length;
      const entry = index.get(key) ?? { sum: 0, by: [] };
      entry.sum += strength;
      entry.by.push({ name: seed.name, strength });
      index.set(key, entry);
    });
  }
  for (const entry of index.values()) entry.by.sort((a, b) => b.strength - a.strength);
  return index;
}

/**
 * 'missing': a title no liked title recommends has no collaborative component,
 * and evidence scores 0.5 to 1, so weak evidence never ranks below none.
 * 'zero': no recommendation counts as 0, and evidence scores 0 to 1. The
 * recommendation check compares the two.
 */
export type CfMode = 'missing' | 'zero';

export function collaborative(entry: CfEntry | undefined, mode: CfMode = 'missing'): number | undefined {
  if (!entry || entry.sum <= 0) return mode === 'zero' ? 0 : undefined;
  const saturated = 1 - Math.exp(-entry.sum);
  return mode === 'zero' ? saturated : 0.5 + 0.5 * saturated;
}

// -------------------------------------------------------------------- blend

export interface Blend {
  score: number;
  /** The share of the score each component supplied. */
  contributions: Components;
  /** The weights after missing components gave theirs away. */
  weights: Components;
}

export function blend(components: Components, weights: Weights): Blend | undefined {
  let total = 0;
  for (const name of COMPONENT_NAMES) {
    if (components[name] != null && weights[name] > 0) total += weights[name];
  }
  if (total === 0) return undefined;
  const contributions: Components = {};
  const used: Components = {};
  let score = 0;
  for (const name of COMPONENT_NAMES) {
    const value = components[name];
    if (value == null || weights[name] <= 0) continue;
    used[name] = weights[name] / total;
    contributions[name] = (weights[name] * value) / total;
    score += contributions[name];
  }
  return { score, contributions, weights: used };
}

// ------------------------------------------------------------- availability

/**
 * 1.00 on a subscribed service; 0.95 free or with ads; 0.85 to rent or buy,
 * or on a service the household does not have; 0.70 unavailable or unknown.
 * Until services are chosen, any streaming service counts as theirs.
 */
export function availability(offers: Offers | null, region: string, services: Set<number> | null): { factor: number; label: string } {
  if (!offers || offers.region !== region) return { factor: 0.7, label: `No availability for ${region} yet` };
  const mine = services ? offers.stream.filter((offer) => services.has(offer.id)) : offers.stream;
  if (mine.length) return { factor: 1, label: `On ${mine[0].name}` };
  if (offers.free.length) return { factor: 0.95, label: `Free on ${offers.free[0].name}` };
  if (offers.ads.length) return { factor: 0.95, label: `Free with ads on ${offers.ads[0].name}` };
  if (offers.stream.length) return { factor: 0.85, label: `On ${offers.stream[0].name}, which you don't have` };
  if (offers.rent.length || offers.buy.length) return { factor: 0.85, label: 'To rent or buy' };
  return { factor: 0.7, label: `Not available in ${region}` };
}
