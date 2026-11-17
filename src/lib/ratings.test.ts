import { describe, expect, it } from 'vitest';
import { effectiveRating, formatRating, householdRating, isValidRating, participantsFor, profilesIn, whoFromParticipants } from './ratings';

describe('ratings', () => {
  it('accepts 1 to 10 in half points only', () => {
    expect([1, 1.5, 7, 9.5, 10].every(isValidRating)).toBe(true);
    expect([0, 0.5, 10.5, 7.25, Number.NaN].some(isValidRating)).toBe(false);
  });

  it('formats whole and half points', () => {
    expect(formatRating(8)).toBe('8');
    expect(formatRating(8.5)).toBe('8.5');
    expect(formatRating(undefined)).toBe('–');
  });

  it('uses a person’s own rating, else inherits the agreed one', () => {
    expect(effectiveRating({ US: 8, A: 9 }, 'A')).toEqual({ value: 9, inherited: false });
    expect(effectiveRating({ US: 8, A: 9 }, 'B')).toEqual({ value: 8, inherited: true });
    expect(effectiveRating({}, 'B')).toEqual({ value: undefined, inherited: false });
  });

  it('shows the agreed rating for the household, else the mean of personal ones to the half point', () => {
    expect(householdRating({ US: 7.5, A: 9 })).toBe(7.5);
    expect(householdRating({ A: 9, B: 8 })).toBe(8.5);
    expect(householdRating({ A: 9, B: 7.5 })).toBe(8.5);
    expect(householdRating({})).toBeUndefined();
  });

  it('maps who watched to the participants bitmask and back', () => {
    expect(participantsFor('A')).toBe(1);
    expect(participantsFor('B')).toBe(2);
    expect(participantsFor('both')).toBe(3);
    expect(profilesIn(3)).toEqual(['A', 'B']);
    expect(profilesIn(2)).toEqual(['B']);
    expect(whoFromParticipants(3)).toBe('both');
    expect(whoFromParticipants(1)).toBe('A');
  });
});
