// Phase 2 reactions: mixing the two rankings, what reactions do to the next
// slates, and the comparison that judges the recommender. Hand-written data only.

import { describe, expect, it } from 'vitest';
import { compare, counted, GATE_DAYS, net, type CompareRow } from './compare';
import { buildSlate, createContext, eligibility } from './engine';
import { feedbackFrom, isResting, type SignalRow } from './feedback';
import { arrange, daySeed, teamDraft, type DraftArm } from './interleave';
import { buildProfile } from './profile';
import { seededRandom } from './random';
import { featureFor, inputFor, NOW, seenTogether, twoTasteWorld } from './testkit';
import { VectorSpace } from './vectors';

const DAY = 86_400_000;
/** Noon, local time, so day boundaries never fall inside a test. */
const NOON = (() => {
  const date = new Date(NOW);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
})();

function draftOf(model: string[], reviews: string[], seed = 1, fits: (key: string) => boolean = () => true) {
  return teamDraft<string>(
    { model, reviews },
    { key: (item) => item, fits, add: () => {}, random: seededRandom(seed), taken: new Set() },
  );
}

describe('team-draft interleaving', () => {
  it('alternate the two rankings, crediting each pick to the one that placed it', () => {
    const placed = draftOf(['m1', 'm2', 'm3', 'm4'], ['r1', 'r2', 'r3', 'r4']).take(6);
    expect(placed.map((entry) => entry.item).sort()).toEqual(['m1', 'm2', 'm3', 'r1', 'r2', 'r3']);
    for (const entry of placed) expect(entry.item[0]).toBe(entry.arm === 'model' ? 'm' : 'r');
    // After every pair of turns the two have placed the same number.
    for (let i = 2; i <= placed.length; i += 2) {
      const arms = placed.slice(0, i).map((entry) => entry.arm);
      expect(arms.filter((arm) => arm === 'model').length).toBe(i / 2);
    }
  });

  it('skip what the other ranking already placed, and credit only the one that placed it', () => {
    const placed = draftOf(['a', 'b', 'c'], ['a', 'b', 'd'], 3).take(4);
    const keys = placed.map((entry) => entry.item);
    expect(new Set(keys).size).toBe(4);
    expect(keys.filter((key) => key === 'a')).toHaveLength(1);
  });

  it('give each ranking the first place about half the time', () => {
    let modelFirst = 0;
    for (let seed = 1; seed <= 400; seed++) if (draftOf(['m1'], ['r1'], seed).take(1)[0].arm === 'model') modelFirst++;
    expect(modelFirst).toBeGreaterThan(160);
    expect(modelFirst).toBeLessThan(240);
  });

  it('respect the caps without losing titles that fit later, and go on when one ranking runs out', () => {
    let allowWide = false;
    const draft = draftOf(['wide1', 'm2'], ['r1', 'r2', 'r3', 'r4'], 5, (key) => allowWide || !key.startsWith('wide'));
    const first = draft.take(2).map((entry) => entry.item);
    expect(first).not.toContain('wide1');
    allowWide = true;
    const rest = draft.take(10);
    expect(rest.map((entry) => entry.item)).toContain('wide1');
    // Every title placed once, and the draft stops when both lists are used up.
    expect(first.length + rest.length).toBe(6);
  });

  it('draw the same mix all day, a different one the next day, and a different one per mode', () => {
    const run = (at: number, mode: string) =>
      draftOf(['m1', 'm2', 'm3', 'm4', 'm5'], ['r1', 'r2', 'r3', 'r4', 'r5'], daySeed(at, mode))
        .take(10)
        .map((entry) => entry.arm)
        .join();
    expect(run(NOON, 'A')).toBe(run(NOON + 3_600_000, 'A'));
    const days = new Set(Array.from({ length: 8 }, (_, i) => run(NOON + i * DAY, 'A')));
    expect(days.size).toBeGreaterThan(1);
    expect(daySeed(NOON, 'A')).not.toBe(daySeed(NOON, 'B'));
  });
});

describe('slate layout', () => {
  const item = (key: string, exploratory = false) => ({ key, exploratory });
  const stored = [
    ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((key) => item(key)),
    item('e1', true),
    item('e2', true),
    item('r7'),
    item('e3', true),
  ];

  it('put exploratory picks at their positions and refill from the reserve when one leaves', () => {
    expect(arrange(stored, new Set(), 6, [3, 6]).map((entry) => entry.key)).toEqual(['r1', 'r2', 'e1', 'r3', 'r4', 'e2']);
    const after = arrange(stored, new Set(['r2', 'e1']), 6, [3, 6]).map((entry) => entry.key);
    expect(after).toEqual(['r1', 'r3', 'e2', 'r4', 'r5', 'e3']);
  });
});

describe('feedback from reactions', () => {
  const row = (type: SignalRow['type'], key: string, at: number, mode: SignalRow['mode'] = 'A'): SignalRow => ({ mode, type, key, at });

  it('hide a Not tonight for 14 days in its mode only, and count three of them as disliked', () => {
    const feedback = feedbackFrom([row('not_tonight', 'movie:1', NOON - 13 * DAY), row('not_tonight', 'movie:2', NOON - 15 * DAY)], NOON);
    expect(feedback.A.hidden.has('movie:1')).toBe(true);
    expect(feedback.A.hidden.has('movie:2')).toBe(false);
    expect(feedback.B.hidden.has('movie:1')).toBe(false);
    expect(feedback.A.implicit.size).toBe(0);
    const thrice = feedbackFrom([1, 20, 40].map((ago) => row('not_tonight', 'movie:3', NOON - ago * DAY)), NOON);
    expect(thrice.A.implicit.get('movie:3')?.kind).toBe('skipped');
  });

  it('keep Together’s Not interested out of Together for good, and nowhere else', () => {
    const feedback = feedbackFrom([row('not_interested', 'movie:4', NOON - 100 * DAY, 'US')], NOON);
    expect(feedback.US.hidden.has('movie:4')).toBe(true);
    expect(feedback.US.implicit.get('movie:4')?.kind).toBe('not_interested');
    expect(feedback.A.hidden.has('movie:4')).toBe(false);
  });

  it('rest a title shown on 5 separate days without an interaction, for 30 days', () => {
    const days = (count: number, from: number) => Array.from({ length: count }, (_, i) => from + i * DAY);
    expect(isResting(days(4, NOON - 10 * DAY), [], NOON)).toBe(false);
    // Five sightings in one day are one day.
    expect(isResting([0, 1, 2, 3, 4].map((h) => NOON - 2 * DAY + h * 3_600_000), [], NOON)).toBe(false);
    expect(isResting(days(5, NOON - 10 * DAY), [], NOON)).toBe(true);
    expect(isResting(days(5, NOON - 40 * DAY), [], NOON)).toBe(false);
    // An interaction after the first sightings starts the count again.
    expect(isResting(days(5, NOON - 10 * DAY), [NOON - 8 * DAY + 3_600_000], NOON)).toBe(false);
    const feedback = feedbackFrom(days(5, NOON - 10 * DAY).map((at) => row('impression', 'movie:5', at)), NOON);
    expect(feedback.A.hidden.has('movie:5')).toBe(true);
  });
});

describe('reactions in the next slates', () => {
  it('leave out hidden titles, but keep titles on the Want to watch list as candidates', () => {
    const world = twoTasteWorld();
    const input = inputFor(world.library, world.features, world.pool);
    const first = buildSlate(createContext(input), 'A').picks[0].key;
    input.feedback.A.hidden.add(first);
    expect(buildSlate(createContext(input), 'A').picks.map((pick) => pick.key)).not.toContain(first);

    // The spec gathers both watchlists into the pool: a listed title can be tonight's pick.
    const listed = { ...seenTogether('x', 'movie:1', 9), ratings: {}, events: [] };
    listed.states = { A: { status: 'watchlist', rewatch: false, at: NOW }, B: { status: 'watchlist', rewatch: false, at: NOW } };
    expect(eligibility(listed, 'A').type).toBe('new');
    expect(eligibility(listed, 'US').type).toBe('new');
  });

  it('let a Not interested on a title outside the library push the profile away from it', () => {
    const rows = [featureFor('movie:1', ['g:1', 'k:1']), featureFor('movie:2', ['g:2', 'k:2']), featureFor('movie:9', ['g:2', 'k:9'])];
    const library = [seenTogether('a', 'movie:1', 9), seenTogether('b', 'movie:2', 8)];
    const space = new VectorSpace(rows);
    const plain = buildProfile(library, 'US', space, NOW);
    const feedback = { hidden: new Set<string>(), implicit: new Map([['movie:9', { kind: 'not_interested' as const, at: NOW }]]) };
    const reacted = buildProfile(library, 'US', space, NOW, new Set(), feedback);
    const entry = reacted.entries.find((item) => item.key === 'movie:9')!;
    expect(entry.titleId).toBeNull();
    expect(entry.value).toBe(reacted.points.disliked - 1);
    expect(reacted.entries).toHaveLength(plain.entries.length + 1);
    // Genre 2 now pulls less: the declined title shares it.
    const genre2 = space.tokens.indexOf('g:2');
    expect(reacted.centroid[genre2]).toBeLessThan(plain.centroid[genre2]);
  });

  it('keep reserves that continue the same alternation, and exploratory reserves apart', () => {
    const world = twoTasteWorld({ omdbForPool: true });
    const slate = buildSlate(createContext(inputFor(world.library, world.features, world.pool, { omdb: world.omdb })), 'US');
    const keys = new Set(slate.picks.map((pick) => pick.key));
    expect(slate.reserve.every((pick) => !keys.has(pick.key))).toBe(true);
    const ranked = slate.reserve.filter((pick) => !pick.exploratory);
    expect(ranked.length).toBeGreaterThan(0);
    expect(new Set(ranked.map((pick) => pick.arm))).toEqual(new Set(['model', 'reviews']));
  });
});

describe('picks compared', () => {
  const row = (type: CompareRow['type'], arm: CompareRow['arm'], key: string, at: number, mode: CompareRow['mode'] = 'A'): CompareRow => ({
    mode,
    type,
    arm,
    key,
    at,
  });
  /** One shown pick a day from each ranking, for a number of days. */
  const shown = (days: number) =>
    Array.from({ length: days }, (_, i) => [
      row('impression', 'model', `movie:${i}`, NOON - (days - i) * DAY),
      row('impression', 'reviews', `movie:${100 + i}`, NOON - (days - i) * DAY),
    ]).flat();

  it('count Want to watch and watched picks for a ranking, Not interested against it, and the rest neither way', () => {
    const rows = [
      ...shown(3),
      row('watchlist', 'model', 'movie:1', NOON - DAY),
      row('pick', 'model', 'movie:1', NOON - DAY + 3_600_000),
      row('not_interested', 'reviews', 'movie:101', NOON - DAY),
      row('not_tonight', 'model', 'movie:2', NOON - DAY),
      row('seen', 'reviews', 'movie:102', NOON - DAY),
      row('watchlist', 'explore', 'movie:300', NOON - DAY),
    ];
    const result = compare(rows, NOON);
    expect(result.total.model.shown).toBe(3);
    expect(net(result.total.model)).toBe(2);
    expect(net(result.total.reviews)).toBe(-1);
    expect(counted(result.total.reviews)).toBe(1);
    expect(result.total.model.notTonight).toBe(1);
    expect(result.total.reviews.seen).toBe(1);
    expect(result.total.explore.wanted).toBe(1);
    expect(result.modes.find((mode) => mode.mode === 'A')!.days).toEqual({ won: 1, lost: 0, tied: 0 });
    expect(result.verdict).toBe('early');
  });

  it(`judge only after ${GATE_DAYS} days and 40 counted reactions, and not when behind in a busy mode`, () => {
    const wants = (count: number, arm: CompareRow['arm'], mode: CompareRow['mode'] = 'A') =>
      Array.from({ length: count }, (_, i) => row('watchlist', arm, `${mode}:${arm}:${i}`, NOON - (i % 10) * DAY, mode));
    expect(compare([...shown(10), ...wants(30, 'model'), ...wants(20, 'reviews')], NOON).verdict).toBe('early');
    expect(compare([...shown(15), ...wants(20, 'model'), ...wants(10, 'reviews')], NOON).verdict).toBe('early');
    expect(compare([...shown(15), ...wants(30, 'model'), ...wants(20, 'reviews')], NOON).verdict).toBe('ahead');
    expect(compare([...shown(15), ...wants(20, 'model'), ...wants(30, 'reviews')], NOON).verdict).toBe('behind');
    // Ahead overall, but behind in Together with 15 or more reactions there.
    const mixed = [...shown(15), ...wants(30, 'model'), ...wants(5, 'reviews'), ...wants(5, 'model', 'US'), ...wants(12, 'reviews', 'US')];
    expect(compare(mixed, NOON).verdict).toBe('even');
  });
});
