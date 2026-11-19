// TF-IDF feature vectors. Each title's tokens are weighted by their family
// (director 1.5, genre 1.0, …) times how rare the token is across all titles,
// then scaled to unit length so a dot product is a cosine. Pure, unit tested.

import { FAMILY_WEIGHT, familyOf, type FeatureRow } from './features';

/** Columns ascending, values scaled to unit length. */
export interface SparseVector {
  cols: Int32Array;
  vals: Float64Array;
}

export class VectorSpace {
  /** Column of each token. */
  readonly index = new Map<string, number>();
  readonly tokens: string[] = [];
  readonly labels: string[] = [];
  readonly idf: Float64Array;
  private readonly vectors = new Map<string, SparseVector>();

  constructor(rows: Iterable<FeatureRow>) {
    const all = [...rows];
    const df: number[] = [];
    for (const row of all) {
      row.tokens.forEach((token, index) => {
        let col = this.index.get(token);
        if (col === undefined) {
          col = this.tokens.length;
          this.index.set(token, col);
          this.tokens.push(token);
          this.labels.push(row.labels[index] ?? token);
          df.push(0);
        }
        df[col]++;
      });
    }
    const n = all.length;
    this.idf = new Float64Array(df.length);
    df.forEach((count, col) => (this.idf[col] = Math.log((n + 1) / (count + 1)) + 1));

    for (const row of all) {
      const pairs = row.tokens
        .map((token) => {
          const col = this.index.get(token) as number;
          return [col, FAMILY_WEIGHT[familyOf(token)] * this.idf[col]] as const;
        })
        .sort((a, b) => a[0] - b[0]);
      const length = Math.hypot(...pairs.map((pair) => pair[1]));
      if (length === 0) continue;
      this.vectors.set(row.key, {
        cols: Int32Array.from(pairs.map((pair) => pair[0])),
        vals: Float64Array.from(pairs.map((pair) => pair[1] / length)),
      });
    }
  }

  get dimension(): number {
    return this.tokens.length;
  }

  vector(key: string): SparseVector | undefined {
    return this.vectors.get(key);
  }
}

/** Dot product of two sparse vectors (a cosine, as both have unit length). */
export function dot(a: SparseVector, b: SparseVector): number {
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < a.cols.length && j < b.cols.length) {
    if (a.cols[i] === b.cols[j]) sum += a.vals[i++] * b.vals[j++];
    else if (a.cols[i] < b.cols[j]) i++;
    else j++;
  }
  return sum;
}

export function dotDense(a: SparseVector, dense: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.cols.length; i++) sum += a.vals[i] * dense[a.cols[i]];
  return sum;
}

export function addScaled(dense: Float64Array, v: SparseVector, scale: number): void {
  for (let i = 0; i < v.cols.length; i++) dense[v.cols[i]] += scale * v.vals[i];
}

export function denseNorm(dense: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < dense.length; i++) sum += dense[i] * dense[i];
  return Math.sqrt(sum);
}

/** Columns two vectors share, with the product of their values, largest first. */
export function shared(a: SparseVector, b: SparseVector): { col: number; weight: number }[] {
  const out: { col: number; weight: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.cols.length && j < b.cols.length) {
    if (a.cols[i] === b.cols[j]) {
      out.push({ col: a.cols[i], weight: a.vals[i] * b.vals[j] });
      i++;
      j++;
    } else if (a.cols[i] < b.cols[j]) i++;
    else j++;
  }
  return out.sort((x, y) => y.weight - x.weight);
}
