// Mixing two rankings into one list, and laying a slate out for display.
// Pure, unit tested.
//
// Team-draft interleaving (Radlinski, Kurup and Joachims, 2008): the two
// rankings take turns placing their best title not yet placed. Whichever has
// placed fewer goes next; on a tie a coin decides. Each ranking so gets the
// top places equally often, and every pick is credited to the ranking that
// placed it, so the household's reactions show which ranking finds more of
// what they want to watch.

import type { Arm } from './types';

export type DraftArm = Exclude<Arm, 'explore'>;

export interface Drafted<T> {
  item: T;
  arm: DraftArm;
}

export interface DraftOptions<T> {
  key: (item: T) => string;
  /** Whether a title may be placed now (the slate's caps). Titles that do not fit stay available. */
  fits: (item: T) => boolean;
  /** Called for every title placed. */
  add: (item: T) => void;
  random: () => number;
  /** Keys already placed by anything else; titles placed by the draft are added to it. */
  taken: Set<string>;
}

export interface Draft<T> {
  /** Places up to count more titles, alternating as above. Fewer when both rankings run out. */
  take(count: number): Drafted<T>[];
}

export function teamDraft<T>(lists: Record<DraftArm, readonly T[]>, options: DraftOptions<T>): Draft<T> {
  const { key, fits, add, random, taken } = options;
  const next: Record<DraftArm, number> = { model: 0, reviews: 0 };
  const team: Record<DraftArm, number> = { model: 0, reviews: 0 };

  const candidate = (arm: DraftArm): T | undefined => {
    const list = lists[arm];
    while (next[arm] < list.length && taken.has(key(list[next[arm]]))) next[arm]++;
    for (let index = next[arm]; index < list.length; index++) {
      const item = list[index];
      if (!taken.has(key(item)) && fits(item)) return item;
    }
    return undefined;
  };

  return {
    take(count) {
      const placed: Drafted<T>[] = [];
      while (placed.length < count) {
        const first: DraftArm =
          team.model < team.reviews ? 'model' : team.reviews < team.model ? 'reviews' : random() < 0.5 ? 'model' : 'reviews';
        const second: DraftArm = first === 'model' ? 'reviews' : 'model';
        let arm = first;
        let item = candidate(first);
        if (item === undefined) {
          arm = second;
          item = candidate(second);
        }
        if (item === undefined) break;
        taken.add(key(item));
        add(item);
        team[arm]++;
        placed.push({ item, arm });
      }
      return placed;
    },
  };
}

/**
 * Lays out picks for display: ranked picks in order, exploratory ones at the
 * exploratory positions, leaving out hidden keys. Items are the slate's full
 * stored list (visible picks first, then reserves), so a pick that leaves is
 * replaced by the next one of its kind.
 */
export function arrange<T extends { key: string; exploratory: boolean }>(
  items: readonly T[],
  hidden: ReadonlySet<string>,
  size: number,
  positions: readonly number[],
): T[] {
  const ranked = items.filter((item) => !item.exploratory && !hidden.has(item.key));
  const exploratory = items.filter((item) => item.exploratory && !hidden.has(item.key));
  const visible: T[] = [];
  let r = 0;
  let e = 0;
  for (let position = 1; position <= size; position++) {
    if (positions.includes(position) && e < exploratory.length) visible.push(exploratory[e++]);
    else if (r < ranked.length) visible.push(ranked[r++]);
    else if (e < exploratory.length) visible.push(exploratory[e++]);
  }
  return visible;
}

/** The coin for a mode's slate on a given local day: the same all day, different the next. */
export function daySeed(at: number, mode: string): number {
  const date = new Date(at);
  const day = date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
  return day * 7 + [...mode].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}
