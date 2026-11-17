import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, filterLibrary, genresIn, localToday, shownRating, yearSpan } from './library';
import type { LibraryItem } from './types';

function item(overrides: Partial<LibraryItem>): LibraryItem {
  return {
    id: overrides.name ?? 'x',
    kind: 'movie',
    name: 'Untitled',
    year: 2000,
    tmdbId: 1,
    source: 'search',
    createdAt: 0,
    posterPath: null,
    genres: [],
    ratings: {},
    status: {},
    wouldRewatch: {},
    watchedTogether: false,
    notes: '',
    ...overrides,
  };
}

const items = [
  item({ name: 'Alpha', year: 1999, createdAt: 3, genres: ['Drama'], ratings: { US: 9 }, status: { A: 'watched', B: 'watched' } }),
  item({ name: 'Bravo', kind: 'series', year: 2015, createdAt: 2, genres: ['Crime', 'Drama'], ratings: { US: 7, B: 9.5 }, status: { B: 'watched', A: 'watchlist' } }),
  item({ name: 'Ça va', year: 2021, createdAt: 1, ratings: { A: 6 }, status: { A: 'watched' }, notes: 'Rewatch with subtitles' }),
];
const names = (list: LibraryItem[]) => list.map((entry) => entry.name);

describe('library filters', () => {
  it('sorts newest additions first by default', () => {
    expect(names(filterLibrary([...items], DEFAULT_FILTERS))).toEqual(['Alpha', 'Bravo', 'Ça va']);
  });

  it('filters by person and status', () => {
    const watched = { ...DEFAULT_FILTERS, status: 'watched' as const };
    expect(names(filterLibrary([...items], { ...watched, person: 'both' }))).toEqual(['Alpha']);
    expect(names(filterLibrary([...items], { ...watched, person: 'A' }))).toEqual(['Alpha', 'Ça va']);
    expect(names(filterLibrary([...items], { ...watched, person: 'any' }))).toEqual(['Alpha', 'Bravo', 'Ça va']);
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, status: 'watchlist', person: 'A' }))).toEqual(['Bravo']);
  });

  it('filters by type and genre, and searches names and notes ignoring accents', () => {
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, kind: 'series' }))).toEqual(['Bravo']);
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, genre: 'Drama' }))).toEqual(['Alpha', 'Bravo']);
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, query: 'ca va' }))).toEqual(['Ça va']);
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, query: 'subtitles' }))).toEqual(['Ça va']);
  });

  it('sorts by the rating shown for the selected person', () => {
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, sort: 'rating' }))).toEqual(['Alpha', 'Bravo', 'Ça va']);
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, sort: 'rating', person: 'B' }).slice(0, 2))).toEqual(['Bravo', 'Alpha']);
    expect(shownRating(items[1], 'B')).toBe(9.5);
    expect(shownRating(items[1], 'A')).toBe(7);
  });

  it('sorts by year and name', () => {
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, sort: 'year' }))).toEqual(['Ça va', 'Bravo', 'Alpha']);
    expect(names(filterLibrary([...items], { ...DEFAULT_FILTERS, sort: 'name' }))).toEqual(['Alpha', 'Bravo', 'Ça va']);
  });

  it('lists genres once, in order', () => {
    expect(genresIn(items)).toEqual(['Crime', 'Drama']);
  });
});

describe('dates and years', () => {
  it('formats the local date as YYYY-MM-DD', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('shows year spans for series', () => {
    expect(yearSpan(2008, null, 'movie', false)).toBe('2008');
    expect(yearSpan(2008, 2013, 'series', false)).toBe('2008–2013');
    expect(yearSpan(2019, null, 'series', true)).toBe('2019–');
    expect(yearSpan(null, null, 'series', true)).toBe('');
  });
});
