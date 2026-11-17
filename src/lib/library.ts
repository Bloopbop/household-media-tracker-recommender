// Library filtering and sorting. Pure, unit tested; runs in memory, which is
// fast enough for thousands of titles.

import { effectiveRating, householdRating } from './ratings';
import type { Kind, LibraryItem, ProfileId, Status } from './types';

export type PersonFilter = 'any' | 'both' | ProfileId;
export type SortOrder = 'added' | 'rating' | 'name' | 'year';

export interface LibraryFilters {
  query: string;
  person: PersonFilter;
  status: Status | 'any';
  kind: Kind | 'any';
  genre: string;
  sort: SortOrder;
}

export const DEFAULT_FILTERS: LibraryFilters = {
  query: '',
  person: 'any',
  status: 'any',
  kind: 'any',
  genre: '',
  sort: 'added',
};

/** The rating shown for a title under the current person filter. */
export function shownRating(item: LibraryItem, person: PersonFilter): number | undefined {
  return person === 'A' || person === 'B' ? effectiveRating(item.ratings, person).value : householdRating(item.ratings);
}

function matchesPerson(item: LibraryItem, filters: LibraryFilters): boolean {
  const has = (person: ProfileId) =>
    filters.status === 'any' ? item.status[person] != null : item.status[person] === filters.status;
  switch (filters.person) {
    case 'A':
    case 'B':
      return has(filters.person);
    case 'both':
      return has('A') && has('B');
    case 'any':
      return filters.status === 'any' || has('A') || has('B');
  }
}

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function filterLibrary(items: LibraryItem[], filters: LibraryFilters): LibraryItem[] {
  const query = fold(filters.query.trim());
  const result = items.filter(
    (item) =>
      matchesPerson(item, filters) &&
      (filters.kind === 'any' || item.kind === filters.kind) &&
      (!filters.genre || item.genres.includes(filters.genre)) &&
      (!query || fold(item.name).includes(query) || fold(item.notes).includes(query)),
  );

  const byName = (a: LibraryItem, b: LibraryItem) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  switch (filters.sort) {
    case 'name':
      return result.sort(byName);
    case 'year':
      return result.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity) || byName(a, b));
    case 'rating':
      return result.sort((a, b) => {
        const left = shownRating(a, filters.person) ?? -Infinity;
        const right = shownRating(b, filters.person) ?? -Infinity;
        return right - left || byName(a, b);
      });
    case 'added':
      return result.sort((a, b) => b.createdAt - a.createdAt || byName(a, b));
  }
}

export function genresIn(items: LibraryItem[]): string[] {
  return [...new Set(items.flatMap((item) => item.genres))].sort((a, b) => a.localeCompare(b));
}

/** Today's date on this device, as YYYY-MM-DD. */
export function localToday(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function yearSpan(year: number | null, endYear: number | null, kind: Kind, ongoing: boolean): string {
  if (year == null) return '';
  if (kind === 'movie') return String(year);
  if (endYear && endYear !== year) return `${year}–${endYear}`;
  return ongoing ? `${year}–` : String(year);
}
