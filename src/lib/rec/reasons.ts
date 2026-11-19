// One sentence per pick, from a template chosen by the largest weighted
// contribution (spec, section 3). Built on the device with no language model,
// at most 140 characters, and citing only titles the viewer liked. Pure, unit
// tested.

import { formatRating } from '../ratings';
import type { Kind, ProfileId } from '../types';
import { familyOf, type FeatureRow } from './features';
import type { Profile } from './profile';
import type { CfEntry, ExternalScores } from './score';
import type { ComponentName, Components, Mode } from './types';
import { dot, shared, type VectorSpace } from './vectors';

export const REASON_MAX = 140;
const EXPLAINING = new Set(['d', 'c', 'w', 'k', 'g']);

export interface ReasonInput {
  mode: Mode;
  names: { A: string; B: string };
  key: string;
  feature: FeatureRow;
  space: VectorSpace;
  profile: Profile;
  contributions: Components;
  cf: CfEntry | undefined;
  external: ExternalScores;
  /** 'cold': too few ratings to judge; 'outside': a well-reviewed title from genres the viewer rarely picks. */
  exploratory: 'cold' | 'outside' | null;
  /** Who has seen it, when it is a rewatch. */
  rewatch: ProfileId[] | null;
  /**
   * How often each liked title has been cited in this slate so far. Reasons
   * prefer a title cited less often when it is nearly as strong, so a slate
   * does not repeat one sentence. Updated as reasons are built.
   */
  cited?: Map<string, number>;
}

export interface Reason {
  text: string;
  template: 'content' | 'collaborative' | 'quality' | 'exploratory' | 'rewatch';
  seeds: { name: string; rating: number; features: string[] }[];
  recommendedBy: string[];
}

export function phrase(token: string, label: string, kind: Kind): string {
  switch (familyOf(token)) {
    case 'd':
      return kind === 'movie' ? `director ${label}` : `creator ${label}`;
    case 'w':
      return `writer ${label}`;
    case 'k':
      return `‘${label}’`;
    case 'g':
      return label.toLowerCase();
    default:
      return label;
  }
}

/** Fits a sentence into the limit by shortening the title it names, then by cutting. */
export function fit(build: (title: string) => string, title: string, max = REASON_MAX): string {
  const full = build(title);
  if (full.length <= max) return full;
  const room = title.length - (full.length - max) - 1;
  if (room >= 12) return build(`${title.slice(0, room).trimEnd()}…`);
  return `${full.slice(0, max - 1).trimEnd()}…`;
}

const timesCited = (input: ReasonInput, name: string) => input.cited?.get(name) ?? 0;

/** Moves a less-cited option to the front when it is within `share` of the strongest. */
function preferFresh<T>(input: ReasonInput, options: T[], strength: (option: T) => number, name: (option: T) => string, share: number): T[] {
  if (options.length < 2 || !input.cited) return options;
  const floor = strength(options[0]) * share;
  const near = options.filter((option) => strength(option) >= floor);
  const pick = [...near].sort((a, b) => timesCited(input, name(a)) - timesCited(input, name(b)) || strength(b) - strength(a))[0];
  return [pick, ...options.filter((option) => option !== pick)];
}

function contentReason(input: ReasonInput): Reason | null {
  const vector = input.space.vector(input.key);
  if (!vector) return null;
  const ranked = input.profile.liked
    .filter((entry) => entry.key !== input.key && input.space.vector(entry.key))
    .map((entry) => ({ entry, sim: dot(vector, input.space.vector(entry.key)!) }))
    .filter((seed) => seed.sim > 0)
    .sort((a, b) => b.sim - a.sim);
  const seeds = preferFresh(input, ranked, (seed) => seed.sim, (seed) => seed.entry.name, 0.8)
    .slice(0, 2)
    .map(({ entry }) => ({
      entry,
      features: shared(vector, input.space.vector(entry.key)!)
        .filter(({ col }) => EXPLAINING.has(familyOf(input.space.tokens[col])))
        .slice(0, 2)
        .map(({ col }) => phrase(input.space.tokens[col], input.space.labels[col], input.feature.kind)),
    }))
    .filter((seed) => seed.features.length > 0);
  if (seeds.length === 0) return null;
  const [best] = seeds;
  const rating = formatRating(best.entry.value);
  const sentence = (features: string[]) => (title: string) => `Shares ${features.join(' and ')} with ${title}, which you rated ${rating}.`;
  let text = fit(sentence(best.features), best.entry.name);
  if (text.endsWith('…') && best.features.length > 1) text = fit(sentence(best.features.slice(0, 1)), best.entry.name);
  return {
    text,
    template: 'content',
    seeds: seeds.map((seed) => ({ name: seed.entry.name, rating: seed.entry.value, features: seed.features })),
    recommendedBy: [],
  };
}

function collaborativeReason(input: ReasonInput): Reason | null {
  const strongest = new Map<string, number>();
  for (const item of input.cf?.by ?? []) strongest.set(item.name, Math.max(strongest.get(item.name) ?? 0, item.strength));
  let options = [...strongest.entries()].sort((a, b) => b[1] - a[1]);
  if (options.length === 0) return null;
  options = preferFresh(input, options, (option) => option[1], (option) => option[0], 0.5);
  options = [options[0], ...preferFresh(input, options.slice(1), (option) => option[1], (option) => option[0], 0.5)];
  const names = options.slice(0, 2).map((option) => option[0]);
  const text =
    names.length === 2
      ? fit((second) => `People who liked ${names[0]} and ${second} tend to like this.`, names[1])
      : fit((only) => `People who liked ${only} tend to like this.`, names[0]);
  return { text, template: 'collaborative', seeds: [], recommendedBy: names };
}

/** The viewer's best-liked genre among this title's, or null if none is liked. */
function likedGenre(input: ReasonInput): string | null {
  let best: { label: string; weight: number } | null = null;
  for (const token of input.feature.genres) {
    const col = input.space.index.get(token);
    if (col === undefined) continue;
    const weight = input.profile.centroid[col];
    if (weight > 0 && (!best || weight > best.weight)) best = { label: input.space.labels[col], weight };
  }
  return best?.label ?? null;
}

function qualityReason(input: ReasonInput): Reason | null {
  const genre = likedGenre(input);
  if (!genre) return null;
  const { rt, mc, imdb, tmdb } = input.external;
  const scores =
    rt != null && mc != null
      ? `${rt}% on Rotten Tomatoes and ${mc} on Metacritic`
      : rt != null
        ? `${rt}% on Rotten Tomatoes`
        : imdb != null
          ? `Rated ${imdb.toFixed(1)} on IMDb`
          : tmdb != null
            ? `Rated ${tmdb.toFixed(1)} by TMDB users`
            : null;
  if (!scores) return null;
  const text = fit((label) => `${scores}, in ${label.toLowerCase()}, which you rate highly.`, genre);
  return { text, template: 'quality', seeds: [], recommendedBy: [] };
}

/** The title's feature that leans most toward the viewer's taste, phrased, or null. */
function tasteFeature(input: ReasonInput): string | null {
  const vector = input.space.vector(input.key);
  let best: { col: number; weight: number } | null = null;
  if (vector) {
    for (let i = 0; i < vector.cols.length; i++) {
      const col = vector.cols[i];
      if (!EXPLAINING.has(familyOf(input.space.tokens[col]))) continue;
      const weight = vector.vals[i] * input.profile.centroid[col];
      if (weight > 0 && (!best || weight > best.weight)) best = { col, weight };
    }
  }
  return best ? phrase(input.space.tokens[best.col], input.space.labels[best.col], input.feature.kind) : null;
}

function exploratoryReason(input: ReasonInput): Reason {
  if (input.exploratory === 'outside') {
    return { text: 'Exploratory: well reviewed, and outside your usual genres.', template: 'exploratory', seeds: [], recommendedBy: [] };
  }
  const feature = tasteFeature(input);
  const text = feature
    ? fit((label) => `Exploratory: not widely rated yet; picked for ${label}.`, feature)
    : 'Exploratory: not widely rated yet; a new direction for you.';
  return { text, template: 'exploratory', seeds: [], recommendedBy: [] };
}

function rewatchReason(input: ReasonInput, seenBy: ProfileId[]): Reason {
  const text =
    input.mode !== 'US'
      ? "You've seen this and would watch it again."
      : seenBy.length === 2
        ? "You've both seen this and would watch it again."
        : fit((name) => `${name} has seen this and would watch it again.`, input.names[seenBy[0]]);
  return { text, template: 'rewatch', seeds: [], recommendedBy: [] };
}

const BUILDERS: Record<Exclude<ComponentName, 'partner'>, (input: ReasonInput) => Reason | null> = {
  content: contentReason,
  collaborative: collaborativeReason,
  quality: qualityReason,
};

export function reasonFor(input: ReasonInput): Reason {
  if (input.rewatch) return rewatchReason(input, input.rewatch);
  if (input.exploratory) return exploratoryReason(input);
  const order = (Object.keys(BUILDERS) as (keyof typeof BUILDERS)[]).sort(
    (a, b) => (input.contributions[b] ?? -1) - (input.contributions[a] ?? -1),
  );
  for (const name of order) {
    const reason = BUILDERS[name](input);
    if (reason) {
      const named = reason.template === 'content' ? reason.seeds.slice(0, 1).map((seed) => seed.name) : reason.recommendedBy;
      for (const title of named) input.cited?.set(title, timesCited(input, title) + 1);
      // Why this? also lists the titles most like this one.
      if (reason.template !== 'content') reason.seeds = contentReason({ ...input, cited: undefined })?.seeds ?? [];
      if (reason.template !== 'collaborative') reason.recommendedBy = collaborativeReason({ ...input, cited: undefined })?.recommendedBy ?? [];
      return reason;
    }
  }
  // Nothing in the viewer's history to point to: say only what is true.
  const feature = tasteFeature(input);
  const { rt, imdb, tmdb } = input.external;
  const scores = rt != null ? `${rt}% on Rotten Tomatoes` : imdb != null ? `rated ${imdb.toFixed(1)} on IMDb` : tmdb != null ? `rated ${tmdb.toFixed(1)} by TMDB users` : null;
  return {
    text: feature
      ? fit((label) => `Picked for ${label}, which runs through titles you liked.`, feature)
      : scores
        ? `Well reviewed: ${scores}.`
        : 'Popular, and new to you.',
    template: 'quality',
    seeds: [],
    recommendedBy: [],
  };
}
