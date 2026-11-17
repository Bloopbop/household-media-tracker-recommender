import { describe, expect, it } from 'vitest';
import type { SearchResult } from './types';
import { decide, hintCountry, mergeNote, normalizeTitle, parseBundle, pickByCreators, type MatchQuery } from './vault';

const result = (overrides: Partial<SearchResult>): SearchResult => ({
  kind: 'movie',
  tmdbId: 1,
  name: 'Sample',
  originalName: '',
  year: 2004,
  posterPath: null,
  popularity: 1,
  originCountry: [],
  ...overrides,
});

const query = (overrides: Partial<MatchQuery>): MatchQuery => ({
  searchTitle: 'Sample',
  hint: '',
  year: 2004,
  kind: 'movie',
  creators: [],
  ...overrides,
});

describe('parseBundle', () => {
  const valid = {
    format: 'hmtr-vault-import',
    version: 1,
    generated_at: '2026-11-17T14:43:27+00:00',
    vault: 'sample',
    library: [
      {
        title: 'Sample (US)',
        search_title: 'Sample',
        title_hint: 'US',
        year: 2011,
        kind: 'series',
        creators: ['A Person'],
        rating: 8.5,
        notes: 'n',
        what_works: '',
        what_doesnt: '',
        source_file: 'wiki/watched/tv-shows/sample.md',
      },
    ],
    candidates: [{ title: 'Later', year: 1999, kind: 'movie', destination: 'candidate_pool', match_score: 'high', source_file: 'wiki/recommendations/later.md' }],
    not_interested: [{ title: 'Nope', year: 2020, source_file: 'wiki/dismissed.md' }],
    needs_review: [{ file: 'wiki/watched/tv-shows/sample.md', title: 'Sample (US)', issue: 'title has a qualifier in brackets', detail: 'x' }],
  };

  it('reads a valid file', () => {
    const parsed = parseBundle(JSON.stringify(valid));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.bundle.library[0]).toMatchObject({ search_title: 'Sample', title_hint: 'US', kind: 'series', rating: 8.5 });
    expect(parsed.bundle.candidates[0]).toMatchObject({ destination: 'candidate_pool', search_title: 'Later', creators: [] });
    expect(parsed.bundle.notInterested).toEqual([{ title: 'Nope', year: 2020, source_file: 'wiki/dismissed.md' }]);
    expect(parsed.bundle.checks).toHaveLength(1);
  });

  it('refuses other files with a plain explanation', () => {
    expect(parseBundle('not json')).toMatchObject({ ok: false });
    expect(parseBundle('{"format":"something-else"}')).toMatchObject({ ok: false, error: expect.stringContaining('vault-import.json') });
    expect(parseBundle(JSON.stringify({ ...valid, version: 2 }))).toMatchObject({ ok: false, error: expect.stringContaining('newer') });
  });

  it('names the row that is broken', () => {
    const broken = { ...valid, library: [{ ...valid.library[0], title: '' }] };
    expect(parseBundle(JSON.stringify(broken))).toEqual({ ok: false, error: 'Watched title 1 has no title.' });
    const badYear = { ...valid, library: [{ ...valid.library[0], year: 'soon' }] };
    expect(parseBundle(JSON.stringify(badYear))).toEqual({ ok: false, error: 'Watched title 1: the year is not a year.' });
  });

  it('drops a rating that is not on the half-point scale instead of guessing', () => {
    const odd = { ...valid, library: [{ ...valid.library[0], rating: 8.25 }] };
    const parsed = parseBundle(JSON.stringify(odd));
    expect(parsed.ok && parsed.bundle.library[0].rating).toBeNull();
  });
});

describe('notes and names', () => {
  it('merges the vault’s three text sections', () => {
    expect(mergeNote({ notes: ' Mine. ', what_works: 'Score', what_doesnt: '' })).toBe('Mine.\n\nWhat works: Score');
    expect(mergeNote({ notes: '', what_works: '', what_doesnt: '' })).toBe('');
  });

  it('compares titles ignoring case, accents, punctuation and &', () => {
    expect(normalizeTitle('Amélie')).toBe(normalizeTitle('amelie'));
    expect(normalizeTitle('Fast & Furious')).toBe(normalizeTitle('Fast and Furious'));
    expect(normalizeTitle('A.I. Artificial Intelligence')).toBe('a i artificial intelligence');
  });

  it('reads country qualifiers', () => {
    expect(hintCountry('UK')).toBe('GB');
    expect(hintCountry('us')).toBe('US');
    expect(hintCountry('Director’s Cut')).toBeNull();
  });
});

describe('decide', () => {
  it('accepts a single exact title with the same year', () => {
    expect(decide(query({}), [result({ tmdbId: 7 }), result({ tmdbId: 8, name: 'Sample 2' })])).toMatchObject({
      type: 'accept',
      match: { tmdbId: 7 },
    });
  });

  it('accepts a year one off, but not two', () => {
    expect(decide(query({}), [result({ year: 2005 })]).type).toBe('accept');
    const far = decide(query({}), [result({ year: 2007 })]);
    expect(far).toMatchObject({ type: 'review', reason: expect.stringContaining('year') });
  });

  it('matches the original title too', () => {
    expect(decide(query({ searchTitle: 'Le Fabuleux Destin' }), [result({ name: 'Amelie', originalName: 'Le Fabuleux Destin' })]).type).toBe(
      'accept',
    );
  });

  it('prefers the exact year among remakes, and asks the creators when that is not enough', () => {
    const remakes = [result({ tmdbId: 1, year: 2004 }), result({ tmdbId: 2, year: 2005 })];
    expect(decide(query({}), remakes)).toMatchObject({ type: 'accept', match: { tmdbId: 1 } });
    const sameYear = [result({ tmdbId: 1 }), result({ tmdbId: 2 })];
    expect(decide(query({}), sameYear)).toMatchObject({ type: 'tiebreak' });
  });

  it('uses a country qualifier to pick between versions', () => {
    const versions = [
      result({ kind: 'series', tmdbId: 10, year: 2011, originCountry: ['US'] }),
      result({ kind: 'series', tmdbId: 11, year: 2011, originCountry: ['GB'] }),
    ];
    expect(decide(query({ kind: 'series', year: 2011, hint: 'UK' }), versions)).toMatchObject({ type: 'accept', match: { tmdbId: 11 } });
  });

  it('never guesses: no exact title means review, with the closest options first', () => {
    const decision = decide(query({}), [
      result({ tmdbId: 1, name: 'Sample: Part 1', popularity: 50 }),
      result({ tmdbId: 2, name: 'Something Else', year: 2004, popularity: 90 }),
    ]);
    expect(decision.type).toBe('review');
    expect(decision.type === 'review' && decision.options.map((option) => option.tmdbId)).toEqual([1, 2]);
    expect(decide(query({}), [])).toMatchObject({ type: 'review', reason: expect.stringContaining('nothing') });
  });

  it('only matches the right type unless told any type will do', () => {
    const series = [result({ kind: 'series' })];
    expect(decide(query({ kind: 'movie' }), series).type).toBe('review');
    expect(decide(query({ kind: '' }), series).type).toBe('accept');
  });
});

describe('pickByCreators', () => {
  it('settles a tie when exactly one option shares a creator', () => {
    const options = [
      { result: result({ tmdbId: 1 }), makers: ['Dee Rector'] },
      { result: result({ tmdbId: 2 }), makers: ['Someone Else'] },
    ];
    expect(pickByCreators(query({ creators: ['dee rector'] }), options)?.tmdbId).toBe(1);
    expect(pickByCreators(query({ creators: [] }), options)).toBeNull();
    expect(pickByCreators(query({ creators: ['Nobody'] }), options)).toBeNull();
  });
});
