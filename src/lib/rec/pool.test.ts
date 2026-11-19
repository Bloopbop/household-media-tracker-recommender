import { describe, expect, it } from 'vitest';
import { discoverQueries } from '../gateway/pool';
import { mergeTop } from './job';
import type { SlateResult } from './types';

describe('pool discover queries', () => {
  it('search each liked genre for the kinds that have it, keywords for both, and people for movies', () => {
    const tokens = ['g:18', 'g:10759', 'g:28', 'g:35', 'k:5', 'd:7', 'c:8', 'k:6'];
    const centroid = Float64Array.from([0.9, 0.8, 0.7, -0.5, 0.6, 0.5, 0.4, 0]);
    const queries = discoverQueries(centroid, tokens).map((query) => `${query.kind} ${JSON.stringify(query.params)}`);
    const base = '"sort_by":"vote_average.desc","vote_count.gte":200';
    expect(queries).toEqual([
      `movie {${base},"with_genres":18}`,
      `series {${base},"with_genres":18}`,
      `series {${base},"with_genres":10759}`,
      `movie {${base},"with_genres":28}`,
      `movie {${base},"with_keywords":5}`,
      `series {${base},"with_keywords":5}`,
      `movie {${base},"with_people":7}`,
      `movie {${base},"with_people":8}`,
    ]);
  });

  it('take at most 5 genres, 10 keywords and 10 people', () => {
    const tokens = [
      ...Array.from({ length: 8 }, (_, i) => `g:${[18, 35, 80, 99, 9648, 37, 16, 10751][i]}`),
      ...Array.from({ length: 15 }, (_, i) => `k:${i + 1}`),
      ...Array.from({ length: 15 }, (_, i) => `d:${i + 1}`),
    ];
    const queries = discoverQueries(Float64Array.from(tokens.map(() => 1)), tokens);
    const genres = new Set(queries.filter((query) => 'with_genres' in query.params).map((query) => query.params.with_genres));
    expect(genres.size).toBe(5);
    expect(queries.filter((query) => 'with_keywords' in query.params)).toHaveLength(20);
    expect(queries.filter((query) => 'with_people' in query.params)).toHaveLength(10);
  });
});

describe('candidates for review scores', () => {
  it('take each mode’s best in turn, without repeats', () => {
    const slate = (top: string[]) => ({ stats: { topCandidates: top } }) as unknown as SlateResult;
    expect(mergeTop([slate(['a', 'b', 'c']), slate(['a', 'd']), slate(['e'])], 4)).toEqual(['a', 'e', 'b', 'd']);
  });
});
