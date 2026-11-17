// Rating rules shared by the whole app. Pure functions, unit tested.

import type { ProfileId, Rater, Who } from './types';

export const RATING_MIN = 1;
export const RATING_MAX = 10;

/** Ratings run from 1 to 10 in half points. */
export function isValidRating(value: number): boolean {
  return Number.isFinite(value) && value >= RATING_MIN && value <= RATING_MAX && Number.isInteger(value * 2);
}

export function formatRating(value: number | null | undefined): string {
  if (value == null) return '–';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export interface EffectiveRating {
  value: number | undefined;
  /** True when the person has no rating of their own and inherits the agreed one. */
  inherited: boolean;
}

/** A person's rating is their own if they have one, and the agreed rating otherwise. */
export function effectiveRating(ratings: Partial<Record<Rater, number>>, person: ProfileId): EffectiveRating {
  const own = ratings[person];
  if (own != null) return { value: own, inherited: false };
  const agreed = ratings.US;
  return { value: agreed, inherited: agreed != null };
}

/** The rating to show for a title when no single person is selected. */
export function householdRating(ratings: Partial<Record<Rater, number>>): number | undefined {
  if (ratings.US != null) return ratings.US;
  const own = [ratings.A, ratings.B].filter((value): value is number => value != null);
  if (own.length === 0) return undefined;
  return Math.round((own.reduce((sum, value) => sum + value, 0) / own.length) * 2) / 2;
}

export function participantsFor(who: Who): 1 | 2 | 3 {
  return who === 'A' ? 1 : who === 'B' ? 2 : 3;
}

export function profilesIn(participants: number): ProfileId[] {
  const people: ProfileId[] = [];
  if (participants & 1) people.push('A');
  if (participants & 2) people.push('B');
  return people;
}

export function whoFromParticipants(participants: number): Who {
  return participants === 3 ? 'both' : participants === 1 ? 'A' : 'B';
}
