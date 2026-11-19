// The recommender against review scores alone, judged by the household's
// reactions. Each slate's ranked places alternate between the two rankings
// (interleave.ts), unlabelled, and every signal records which one placed the
// pick. Pure, unit tested; loadComparison reads the signals.
//
// What counts: Want to watch and watching a pick within 14 days of seeing it
// count for a ranking; Not interested counts against it. Not tonight is a
// skip and Seen it means the pick was already watched; both are reported but
// count neither way.
//
// The gate: after at least 14 days and 40 counted reactions, the recommender
// must be ahead overall and not behind in any mode with 15 or more.

import { exec } from '../db';
import { localDay, type SignalType } from './feedback';
import { MODES, type Arm, type Mode } from './types';

const DAY_MS = 86_400_000;
export const GATE_DAYS = 14;
export const GATE_REACTIONS = 40;
export const GATE_MODE_REACTIONS = 15;

export interface CompareRow {
  mode: Mode;
  type: SignalType;
  key: string;
  at: number;
  arm: Arm;
}

export interface Tally {
  /** Distinct titles that came into view. */
  shown: number;
  opened: number;
  wanted: number;
  /** Watched within 14 days of being shown. */
  picked: number;
  notInterested: number;
  notTonight: number;
  /** Seen it: already watched. */
  seen: number;
}

export interface DayRecord {
  won: number;
  lost: number;
  tied: number;
}

export interface ModeComparison {
  mode: Mode;
  model: Tally;
  reviews: Tally;
  explore: Tally;
  /** Days with counted reactions, by which ranking came out ahead that day. */
  days: DayRecord;
}

export type Verdict = 'early' | 'ahead' | 'behind' | 'even';

export interface Comparison {
  /** When the first mixed slate was seen, or null. */
  since: number | null;
  days: number;
  modes: ModeComparison[];
  total: Omit<ModeComparison, 'mode'>;
  verdict: Verdict;
}

export const emptyTally = (): Tally => ({ shown: 0, opened: 0, wanted: 0, picked: 0, notInterested: 0, notTonight: 0, seen: 0 });
export const net = (tally: Tally) => tally.wanted + tally.picked - tally.notInterested;
export const counted = (tally: Tally) => tally.wanted + tally.picked + tally.notInterested;

function tallies(rows: CompareRow[]): Record<Arm, Tally> {
  const result: Record<Arm, Tally> = { model: emptyTally(), reviews: emptyTally(), explore: emptyTally() };
  const distinct = new Map<string, Set<string>>();
  const once = (arm: Arm, type: string, key: string) => {
    const id = `${arm}|${type}`;
    const set = distinct.get(id) ?? new Set<string>();
    distinct.set(id, set);
    if (set.has(key)) return false;
    set.add(key);
    return true;
  };
  for (const row of rows) {
    const tally = result[row.arm];
    switch (row.type) {
      case 'impression':
        if (once(row.arm, row.type, row.key)) tally.shown++;
        break;
      case 'open':
        if (once(row.arm, row.type, row.key)) tally.opened++;
        break;
      case 'pick':
        if (once(row.arm, row.type, row.key)) tally.picked++;
        break;
      case 'watchlist':
        tally.wanted++;
        break;
      case 'not_interested':
        tally.notInterested++;
        break;
      case 'not_tonight':
        tally.notTonight++;
        break;
      case 'seen':
        tally.seen++;
        break;
    }
  }
  return result;
}

function dayRecord(rows: CompareRow[]): DayRecord {
  const byDay = new Map<string, { model: number; reviews: number }>();
  for (const row of rows) {
    if (row.arm === 'explore') continue;
    const value = row.type === 'watchlist' || row.type === 'pick' ? 1 : row.type === 'not_interested' ? -1 : 0;
    if (value === 0) continue;
    const day = `${row.mode}|${localDay(row.at)}`;
    const score = byDay.get(day) ?? { model: 0, reviews: 0 };
    score[row.arm] += value;
    byDay.set(day, score);
  }
  const record: DayRecord = { won: 0, lost: 0, tied: 0 };
  for (const score of byDay.values()) {
    if (score.model > score.reviews) record.won++;
    else if (score.model < score.reviews) record.lost++;
    else record.tied++;
  }
  return record;
}

export function compare(rows: readonly CompareRow[], now: number): Comparison {
  const mixed = rows.filter((row) => row.type === 'impression' && row.arm !== 'explore').map((row) => row.at);
  const since = mixed.length ? Math.min(...mixed) : null;
  const days = since == null ? 0 : Math.floor((now - since) / DAY_MS);
  const modes = MODES.map((mode) => {
    const mine = rows.filter((row) => row.mode === mode);
    return { mode, ...tallies(mine), days: dayRecord(mine) };
  });
  const all = tallies([...rows]);
  // Distinct titles are counted per mode, then added up.
  for (const arm of ['model', 'reviews', 'explore'] as const) {
    for (const field of ['shown', 'opened', 'picked'] as const) all[arm][field] = modes.reduce((sum, mode) => sum + mode[arm][field], 0);
  }
  const total = { ...all, days: dayRecord([...rows]) };

  const reactions = counted(total.model) + counted(total.reviews);
  let verdict: Verdict;
  if (since == null || days < GATE_DAYS || reactions < GATE_REACTIONS) verdict = 'early';
  else {
    const behindSomewhere = modes.some(
      (mode) => counted(mode.model) + counted(mode.reviews) >= GATE_MODE_REACTIONS && net(mode.model) < net(mode.reviews),
    );
    const difference = net(total.model) - net(total.reviews);
    verdict = difference < 0 ? 'behind' : difference > 0 && !behindSomewhere ? 'ahead' : 'even';
  }
  return { since, days, modes, total, verdict };
}

export async function loadComparison(now = Date.now()): Promise<Comparison> {
  const rows = await exec<CompareRow>(
    `SELECT mode, type, title_key AS key, at, arm FROM signal
      WHERE arm IN ('model', 'reviews', 'explore') AND title_key IS NOT NULL ORDER BY at`,
  );
  return compare(rows, now);
}
