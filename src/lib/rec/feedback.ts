// What reactions to picks mean for the next slates (spec, sections 3 and 4).
// Pure, unit tested; data.ts loads the signal rows.
//
// - Not tonight hides a title from that mode for 14 days; three of them count
//   as disliked.
// - Not interested in Together hides it from Together for good and counts as
//   one point below disliked there. (A person's own Not interested is a
//   library status, which the eligibility rules already read.)
// - Fatigue: a title shown on 5 separate days with no interaction rests for
//   30 days. A "session" in the spec is taken as a day, so opening the app
//   several times in an evening does not wear a title out.

import { MODES, noFeedback, type Mode, type ModeFeedback } from './types';

const DAY_MS = 86_400_000;
export const NOT_TONIGHT_DAYS = 14;
export const SKIPS_FOR_DISLIKED = 3;
export const FATIGUE_DAYS = 5;
export const REST_DAYS = 30;

export type SignalType = 'impression' | 'open' | 'watchlist' | 'seen' | 'not_tonight' | 'not_interested' | 'pick';

export interface SignalRow {
  mode: Mode;
  type: SignalType;
  key: string;
  at: number;
}

/** The local calendar day of a time, as YYYY-MM-DD. */
export function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Start of the local day containing at. */
const dayStart = (at: number) => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/**
 * Whether a title is resting now: shown on FATIGUE_DAYS separate days since
 * its last interaction (or last rest), without one. Times in any order.
 */
export function isResting(impressions: number[], interactions: number[], now: number): boolean {
  const lastInteraction = Math.max(-Infinity, ...interactions);
  const days = [...new Set(impressions.filter((at) => at > lastInteraction).map(dayStart))].sort((a, b) => a - b);
  let count = 0;
  let restUntil = -Infinity;
  for (const day of days) {
    if (day < restUntil) continue;
    count++;
    if (count === FATIGUE_DAYS) {
      restUntil = day + REST_DAYS * DAY_MS;
      count = 0;
    }
  }
  return now < restUntil;
}

export function feedbackFrom(rows: readonly SignalRow[], now: number): Record<Mode, ModeFeedback> {
  const feedback = noFeedback();
  const recent = now - NOT_TONIGHT_DAYS * DAY_MS;
  const byTitle = new Map<string, SignalRow[]>();
  for (const row of rows) {
    const id = `${row.mode}|${row.key}`;
    const list = byTitle.get(id) ?? [];
    list.push(row);
    byTitle.set(id, list);
  }
  for (const [id, list] of byTitle) {
    const [mode, key] = id.split('|') as [Mode, string];
    if (!MODES.includes(mode)) continue;
    const mine = feedback[mode];
    const skips = list.filter((row) => row.type === 'not_tonight');
    if (skips.some((row) => row.at >= recent)) mine.hidden.add(key);
    if (skips.length >= SKIPS_FOR_DISLIKED) {
      mine.implicit.set(key, { kind: 'skipped', at: Math.max(...skips.map((row) => row.at)) });
    }
    const declined = list.filter((row) => row.type === 'not_interested');
    if (mode === 'US' && declined.length > 0) {
      mine.hidden.add(key);
      mine.implicit.set(key, { kind: 'not_interested', at: Math.max(...declined.map((row) => row.at)) });
    }
    const impressions = list.filter((row) => row.type === 'impression').map((row) => row.at);
    const interactions = list.filter((row) => row.type !== 'impression').map((row) => row.at);
    if (impressions.length >= FATIGUE_DAYS && isResting(impressions, interactions, now)) mine.hidden.add(key);
  }
  return feedback;
}
