// The score components and how they combine (spec, section 3). Each part is
// turned into a percentile among the titles ranked together, so every part
// runs 0 to 1; a missing one gives its weight to the others in proportion.
// Pure, unit tested.

import type { OmdbScores } from '../types';
import type { FeatureRow, Offers } from './features';
import { signedWeight, type Profile } from './profile';
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
  /**
   * Over every title the rater has rated: its signed weight (above or below
   * their mean) times how high this title sits in its TMDB recommendations
   * (1 at the top). Positive when the titles that list it were loved; near
   * zero when loved and unloved titles list it alike.
   */
  sum: number;
  /** Liked titles that list it, strongest first: for reasons. */
  by: { name: string; strength: number }[];
}

/**
 * The collaborative part (spec, section 3, changed 18 November 2026): every
 * rated title's TMDB recommendations count, weighted like the content
 * centroid. Counting only liked titles' lists rewarded popular titles that
 * appear on everyone's lists: on the household's ratings that ranked their
 * favourites below the rest (AUC 0.43 to 0.45).
 */
export function buildCfIndex(profile: Profile, features: Map<string, FeatureRow>, now: number): Map<string, CfEntry> {
  const index = new Map<string, CfEntry>();
  for (const entry of profile.entries) {
    const recs = features.get(entry.key)?.recs ?? [];
    if (recs.length === 0) continue;
    const weight = signedWeight(entry, profile.mean, profile.sd, now);
    const liked = entry.value >= profile.points.liked;
    recs.forEach((key, position) => {
      const strength = weight * (1 - position / recs.length);
      const found = index.get(key) ?? { sum: 0, by: [] };
      found.sum += strength;
      if (liked && strength > 0) found.by.push({ name: entry.name, strength });
      index.set(key, found);
    });
  }
  for (const found of index.values()) found.by.sort((a, b) => b.strength - a.strength);
  return index;
}

// --------------------------------------------------------------- normalizing

/**
 * Each part as a percentile among the titles being ranked together, so a
 * weight means what it says whatever the part's natural spread: raw content
 * scores barely move, review scores move a lot. Ties share the middle rank.
 * Titles missing a part stay missing.
 */
export function toPercentiles(items: { components: Components }[]): void {
  for (const name of COMPONENT_NAMES) {
    const present = items.filter((item) => item.components[name] != null);
    if (present.length === 0) continue;
    if (present.length === 1) {
      present[0].components[name] = 0.5;
      continue;
    }
    const sorted = [...present].sort((a, b) => (a.components[name] as number) - (b.components[name] as number));
    let start = 0;
    while (start < sorted.length) {
      let end = start;
      const value = sorted[start].components[name];
      while (end + 1 < sorted.length && sorted[end + 1].components[name] === value) end++;
      const rank = (start + end) / 2;
      for (let i = start; i <= end; i++) sorted[i].components[name] = rank / (sorted.length - 1);
      start = end + 1;
    }
  }
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
