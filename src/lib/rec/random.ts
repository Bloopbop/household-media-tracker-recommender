// Seeded random numbers, so a backtest draw can be repeated exactly. Pure.

/** mulberry32: small, fast and good enough for sampling. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** count items drawn without replacement, in a random order. */
export function sample<T>(items: readonly T[], count: number, random: () => number): T[] {
  const copy = [...items];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** The month's seed, as the spec asks: the same draw all month, a new one next month. */
export const monthSeed = (date: Date) => date.getFullYear() * 100 + date.getMonth() + 1;
