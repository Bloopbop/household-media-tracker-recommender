// The vault import file, and how its titles are matched to TMDB entries.
// Pure functions, unit tested; importer.ts does the storage and network side.

import type { Kind, SearchResult } from './types';

export const BUNDLE_FORMAT = 'hmtr-vault-import';
export const BUNDLE_VERSION = 1;

interface VaultTitleFields {
  title: string;
  search_title: string;
  title_hint: string;
  year: number | null;
  kind: Kind | '';
  creators: string[];
  source_file: string;
}

export interface VaultLibraryRow extends VaultTitleFields {
  rating: number | null;
  notes: string;
  what_works: string;
  what_doesnt: string;
}

export interface VaultCandidateRow extends VaultTitleFields {
  destination: 'candidate_pool' | 'watchlist';
  match_score: string;
}

export interface VaultNotInterestedRow {
  title: string;
  year: number | null;
  source_file: string;
}

export interface VaultCheck {
  file: string;
  title: string;
  issue: string;
  detail: string;
}

export interface VaultBundle {
  generatedAt: string;
  vault: string;
  library: VaultLibraryRow[];
  candidates: VaultCandidateRow[];
  notInterested: VaultNotInterestedRow[];
  checks: VaultCheck[];
}

export type BundleResult = { ok: true; bundle: VaultBundle } | { ok: false; error: string };

// ----------------------------------------------------------------- parsing

type Raw = Record<string, unknown>;

class BundleError extends Error {}

const text = (row: Raw, field: string, where: string, required = false): string => {
  const value = row[field];
  if (value == null || value === '') {
    if (required) throw new BundleError(`${where} has no ${field.replace('_', ' ')}.`);
    return '';
  }
  if (typeof value !== 'string') throw new BundleError(`${where}: ${field} should be text.`);
  return value;
};

const year = (row: Raw, where: string): number | null => {
  const value = row.year;
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1870 || value > 2100) {
    throw new BundleError(`${where}: the year is not a year.`);
  }
  return value;
};

const names = (row: Raw, field: string): string[] =>
  Array.isArray(row[field]) ? (row[field] as unknown[]).filter((item): item is string => typeof item === 'string' && item !== '') : [];

const kindOf = (row: Raw): Kind | '' => (row.kind === 'movie' || row.kind === 'series' ? row.kind : '');

function titleFields(row: Raw, where: string): VaultTitleFields {
  const title = text(row, 'title', where, true);
  return {
    title,
    search_title: text(row, 'search_title', where) || title,
    title_hint: text(row, 'title_hint', where),
    year: year(row, where),
    kind: kindOf(row),
    creators: names(row, 'creators'),
    source_file: text(row, 'source_file', where, true),
  };
}

function rows(bundle: Raw, field: string): Raw[] {
  const value = bundle[field];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new BundleError(`The file's ${field.replace('_', ' ')} section is damaged.`);
  return value.map((row, index) => {
    if (!row || typeof row !== 'object') throw new BundleError(`Row ${index + 1} of ${field.replace('_', ' ')} is damaged.`);
    return row as Raw;
  });
}

export function parseBundle(content: string): BundleResult {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, error: 'This is not a vault import file. Choose vault-import.json from the converter.' };
  }
  if (!raw || typeof raw !== 'object' || (raw as Raw).format !== BUNDLE_FORMAT) {
    return { ok: false, error: 'This is not a vault import file. Choose vault-import.json from the converter.' };
  }
  const bundle = raw as Raw;
  if (typeof bundle.version !== 'number' || bundle.version > BUNDLE_VERSION) {
    return { ok: false, error: 'This file was made by a newer converter. Reload the app to update it, then try again.' };
  }
  try {
    return {
      ok: true,
      bundle: {
        generatedAt: typeof bundle.generated_at === 'string' ? bundle.generated_at : '',
        vault: typeof bundle.vault === 'string' ? bundle.vault : '',
        library: rows(bundle, 'library').map((row, index) => {
          const where = `Watched title ${index + 1}`;
          const rating = row.rating;
          const valid = typeof rating === 'number' && rating >= 1 && rating <= 10 && Number.isInteger(rating * 2);
          return {
            ...titleFields(row, where),
            rating: valid ? rating : null,
            notes: text(row, 'notes', where),
            what_works: text(row, 'what_works', where),
            what_doesnt: text(row, 'what_doesnt', where),
          };
        }),
        candidates: rows(bundle, 'candidates').map((row, index) => ({
          ...titleFields(row, `Recommendation ${index + 1}`),
          destination: row.destination === 'watchlist' ? 'watchlist' : 'candidate_pool',
          match_score: typeof row.match_score === 'string' ? row.match_score : '',
        })),
        notInterested: rows(bundle, 'not_interested').map((row, index) => {
          const where = `Not-interested title ${index + 1}`;
          return { title: text(row, 'title', where, true), year: year(row, where), source_file: text(row, 'source_file', where) };
        }),
        checks: rows(bundle, 'needs_review').map((row) => ({
          file: typeof row.file === 'string' ? row.file : '',
          title: typeof row.title === 'string' ? row.title : '',
          issue: typeof row.issue === 'string' ? row.issue : '',
          detail: typeof row.detail === 'string' ? row.detail : '',
        })),
      },
    };
  } catch (error) {
    if (error instanceof BundleError) return { ok: false, error: error.message };
    throw error;
  }
}

/** The vault's three free-text sections, as one note. */
export function mergeNote(row: Pick<VaultLibraryRow, 'notes' | 'what_works' | 'what_doesnt'>): string {
  const parts: string[] = [];
  if (row.notes.trim()) parts.push(row.notes.trim());
  if (row.what_works.trim()) parts.push(`What works: ${row.what_works.trim()}`);
  if (row.what_doesnt.trim()) parts.push(`What doesn't: ${row.what_doesnt.trim()}`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- matching

export interface MatchQuery {
  searchTitle: string;
  hint: string;
  year: number | null;
  kind: Kind | '';
  creators: string[];
}

export type Decision =
  | { type: 'accept'; match: SearchResult; reason: string }
  | { type: 'tiebreak'; options: SearchResult[] }
  | { type: 'review'; options: SearchResult[]; reason: string };

const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Compares titles ignoring case, accents, punctuation and "&" versus "and". */
export function normalizeTitle(value: string): string {
  return fold(value)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function normalizeName(value: string): string {
  return fold(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A bracketed qualifier as a country code: "UK" is GB in TMDB's data. */
export function hintCountry(hint: string): string | null {
  const code = hint.trim().toUpperCase();
  if (code === 'UK') return 'GB';
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function yearGap(query: MatchQuery, result: SearchResult): number | null {
  return query.year == null || result.year == null ? null : Math.abs(result.year - query.year);
}

function isExact(query: MatchQuery, result: SearchResult): boolean {
  const target = normalizeTitle(query.searchTitle);
  return normalizeTitle(result.name) === target || (result.originalName !== '' && normalizeTitle(result.originalName) === target);
}

/** Share of words two titles have in common, from 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const right = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

/** Orders possible matches for a person to choose from: closest title, then year, then popularity. */
export function rankOptions(query: MatchQuery, results: SearchResult[]): SearchResult[] {
  const score = (result: SearchResult) => [
    isExact(query, result) ? 0 : 1,
    -Math.max(titleSimilarity(query.searchTitle, result.name), titleSimilarity(query.searchTitle, result.originalName)),
    yearGap(query, result) ?? 5,
    -result.popularity,
  ];
  return [...results].sort((a, b) => {
    const left = score(a);
    const right = score(b);
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
  });
}

/**
 * Accepts a match only when it is unambiguous: the title matches exactly and
 * the year is within one (release and festival years often differ by one).
 * Anything else is left for a person, never guessed.
 */
export function decide(query: MatchQuery, results: SearchResult[]): Decision {
  const pool = query.kind ? results.filter((result) => result.kind === query.kind) : results;
  const exact = pool.filter((result) => isExact(query, result));
  const plausible = exact.filter((result) => (yearGap(query, result) ?? 0) <= 1);

  const country = hintCountry(query.hint);
  if (country) {
    const hinted = plausible.filter((result) => result.originCountry.includes(country));
    if (hinted.length === 1) return { type: 'accept', match: hinted[0], reason: 'title, year and country match' };
  }

  if (plausible.length === 1) {
    const gap = yearGap(query, plausible[0]);
    return {
      type: 'accept',
      match: plausible[0],
      reason: gap === 0 ? 'title and year match' : gap === 1 ? 'title matches; year is one off' : 'title matches',
    };
  }
  if (plausible.length > 1) {
    const sameYear = plausible.filter((result) => yearGap(query, result) === 0);
    if (sameYear.length === 1) return { type: 'accept', match: sameYear[0], reason: 'title and year match' };
    return { type: 'tiebreak', options: rankOptions(query, sameYear.length > 1 ? sameYear : plausible).slice(0, 3) };
  }

  const options = rankOptions(query, pool.length > 0 ? pool : results).slice(0, 5);
  const reason =
    results.length === 0
      ? 'TMDB found nothing under this title.'
      : exact.length > 0
        ? 'The title matches, but the year is more than one off.'
        : 'No result has exactly this title.';
  return { type: 'review', options, reason };
}

/** Breaks a tie using the people who made it. Returns null if that does not settle it. */
export function pickByCreators(query: MatchQuery, options: { result: SearchResult; makers: string[] }[]): SearchResult | null {
  const wanted = new Set(query.creators.map(normalizeName).filter(Boolean));
  if (wanted.size === 0) return null;
  const matching = options.filter((option) => option.makers.some((name) => wanted.has(normalizeName(name))));
  return matching.length === 1 ? matching[0].result : null;
}
