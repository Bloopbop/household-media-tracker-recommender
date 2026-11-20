// Reactions to picks on For you (spec, R5), and the signals logged around
// them. A reaction is one tap: it saves what it means in the library, logs a
// signal credited to the ranking that placed the pick, and takes the pick off
// the slate. Each one can be undone for a few seconds.

import { batch, exec, type Statement } from '../db';
import { participantsFor } from '../ratings';
import { newTitleStatement, ratingStatement, stateStatement } from '../repo';
import { app, changed, SESSION_ID } from '../state.svelte';
import type { Kind, ProfileId, Rater, Status } from '../types';
import { peopleIn } from './profile';
import { absorbChange, dataFingerprint, latestFingerprint, type StoredPick } from './store';
import type { Mode } from './types';

export type Reaction = 'watchlist' | 'seen' | 'not_tonight' | 'not_interested';

export const REACTION_LABEL: Record<Reaction, string> = {
  watchlist: 'Want to watch',
  seen: 'Seen it',
  not_tonight: 'Not tonight',
  not_interested: 'Not interested',
};

/**
 * The reactions offered for a pick in a mode. A rewatch has been seen
 * already; a title already on everyone's list needs no Want to watch.
 */
export function reactionsFor(pick: { rewatch: boolean; listedBy: ProfileId[] }, mode: Mode): Reaction[] {
  const listed = peopleIn(mode).every((person) => pick.listedBy.includes(person));
  return (['watchlist', 'seen', 'not_tonight', 'not_interested'] as Reaction[]).filter(
    (reaction) => !(reaction === 'watchlist' && listed) && !(reaction === 'seen' && pick.rewatch),
  );
}

/** Whose rating Seen it asks for: a person's own, or the agreed one in Together. */
export const raterFor = (mode: Mode): Rater => mode;

export interface Target {
  mode: Mode;
  pick: StoredPick;
  /** Where it sat on screen, 1 to 20. */
  position: number;
}

export interface Done {
  message: string;
  undo: () => Promise<void>;
}

const uuid = () => crypto.randomUUID();
const parseKey = (key: string) => {
  const [kind, id] = key.split(':');
  return { kind: kind as Kind, tmdbId: Number(id) };
};

function signalStatement(id: string, type: string, target: Target, titleId: string | null): Statement {
  return {
    sql: `INSERT INTO signal (id, at, mode, type, title_key, title_id, slate_id, rank, session, arm)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [id, Date.now(), target.mode, type, target.pick.key, titleId, target.pick.slateId, target.position, SESSION_ID, target.pick.arm],
  };
}

interface StateRow {
  profile_id: ProfileId;
  status: Status | null;
  would_rewatch: number;
  updated_at: number;
}

interface RatingRow {
  score: number;
  rated_at: number;
  source: string;
}

/** Runs writes that change the library without reshuffling today's slates. */
async function write(statements: Statement[]): Promise<void> {
  const before = await dataFingerprint(app.region);
  const current = (await latestFingerprint()) === before;
  await batch(statements);
  if (current) await absorbChange(before, await dataFingerprint(app.region));
  app.slatesVersion++;
  changed();
}

function messageFor(reaction: Reaction, mode: Mode, rewatch: boolean): string {
  switch (reaction) {
    case 'watchlist':
      return rewatch ? 'Noted: you want to watch it again' : mode === 'US' ? 'Added to both lists' : 'Added to Want to watch';
    case 'seen':
      return 'Saved as seen';
    case 'not_tonight':
      return 'Hidden for 14 days';
    case 'not_interested':
      if (rewatch) return 'No longer suggested as a rewatch';
      return mode === 'US' ? 'Won’t be suggested for the two of you' : 'Won’t be suggested again';
  }
}

/**
 * Saves a reaction. Seen it takes the rating to save (null for none). Returns
 * a message for the screen and a function that takes it all back.
 */
export async function react(target: Target, reaction: Reaction, rating: number | null = null): Promise<Done> {
  const { mode, pick } = target;
  const people = peopleIn(mode);
  const rater = raterFor(mode);
  const statements: Statement[] = [];
  const undo: Statement[] = [];

  // A title the reaction must record in the library, added if new.
  const needsTitle =
    reaction === 'watchlist' || reaction === 'seen' || (reaction === 'not_interested' && (mode !== 'US' || pick.rewatch));
  let titleId = pick.titleId;
  if (!titleId) {
    const { kind, tmdbId } = parseKey(pick.key);
    const [row] = await exec<{ id: string }>('SELECT id FROM title WHERE kind = ? AND tmdb_id = ?', [kind, tmdbId]);
    titleId = row?.id ?? null;
    if (!titleId && needsTitle) {
      titleId = uuid();
      statements.push(newTitleStatement(titleId, { kind, name: pick.name, year: pick.year, tmdbId, source: 'slate' }));
      // Deleting the title takes its states, rating and watch with it.
      undo.push({ sql: 'DELETE FROM title WHERE id = ?', bind: [titleId] });
    }
  }
  const created = undo.length > 0;

  let before = new Map<ProfileId, StateRow>();
  if (titleId && !created) {
    const states = await exec<StateRow>(
      'SELECT profile_id, status, would_rewatch, updated_at FROM title_state WHERE title_id = ?',
      [titleId],
    );
    before = new Map(states.map((row) => [row.profile_id, row]));
    // Undo puts back every person's state as it was.
    for (const person of people) {
      const row = before.get(person);
      undo.push(
        row
          ? {
              sql: 'UPDATE title_state SET status = ?, would_rewatch = ?, updated_at = ? WHERE profile_id = ? AND title_id = ?',
              bind: [row.status, row.would_rewatch, row.updated_at, person, titleId],
            }
          : { sql: 'DELETE FROM title_state WHERE profile_id = ? AND title_id = ?', bind: [person, titleId] },
      );
    }
    if (reaction === 'seen') {
      const [previous] = await exec<RatingRow>('SELECT score, rated_at, source FROM rating WHERE rater = ? AND title_id = ?', [
        rater,
        titleId,
      ]);
      undo.push(
        previous
          ? {
              sql: 'INSERT OR REPLACE INTO rating (rater, title_id, score, rated_at, source) VALUES (?, ?, ?, ?, ?)',
              bind: [rater, titleId, previous.score, previous.rated_at, previous.source],
            }
          : { sql: 'DELETE FROM rating WHERE rater = ? AND title_id = ?', bind: [rater, titleId] },
      );
    }
  }
  const statusOf = (person: ProfileId) => before.get(person)?.status ?? null;

  if (titleId) {
    switch (reaction) {
      case 'watchlist':
        // On the list of whoever has nothing recorded yet; a rewatch keeps its status.
        for (const person of people) if (statusOf(person) == null) statements.push(stateStatement(person, titleId, 'watchlist'));
        break;
      case 'seen': {
        const eventId = uuid();
        statements.push({
          sql: `INSERT INTO watch_event (id, title_id, participants, watched_on, completion, is_rewatch, source, created_at)
                VALUES (?, ?, ?, NULL, 1, 0, 'slate', ?)`,
          bind: [eventId, titleId, participantsFor(mode === 'US' ? 'both' : mode), Date.now()],
        });
        if (!created) undo.push({ sql: 'DELETE FROM watch_event WHERE id = ?', bind: [eventId] });
        for (const person of people) statements.push(stateStatement(person, titleId, 'watched'));
        if (rating != null) statements.push(ratingStatement(rater, titleId, rating, 'slate'));
        break;
      }
      case 'not_interested':
        if (pick.rewatch) {
          for (const person of people) {
            statements.push({
              sql: 'UPDATE title_state SET would_rewatch = 0, updated_at = ? WHERE profile_id = ? AND title_id = ?',
              bind: [Date.now(), person, titleId],
            });
          }
        } else if (mode !== 'US') {
          statements.push(stateStatement(mode, titleId, 'not_interested'));
        }
        break;
      case 'not_tonight':
        break;
    }
  }

  const signalId = uuid();
  statements.push(signalStatement(signalId, reaction, target, titleId));
  undo.push({ sql: 'DELETE FROM signal WHERE id = ?', bind: [signalId] });

  await write(statements);
  return {
    message: messageFor(reaction, mode, pick.rewatch),
    undo: () => write(undo.reverse()),
  };
}

// ----------------------------------------------------------- passive signals

const logged = new Set<string>();
let pending: Statement[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  const statements = pending;
  pending = [];
  timer = undefined;
  // Signals are a record, not data anything waits on: a failed write is dropped.
  if (statements.length) void batch(statements).catch(() => 0);
}

function logOnce(type: 'impression' | 'open', target: Target): void {
  const id = `${type}|${target.pick.slateId}|${target.pick.key}`;
  if (logged.has(id)) return;
  logged.add(id);
  pending.push(signalStatement(uuid(), type, target, target.pick.titleId));
  timer ??= setTimeout(flush, 500);
}

/** A pick came into view (once per slate and session): the exposure count and the fatigue rule. */
export const logImpression = (target: Target) => logOnce('impression', target);

/** A pick's page was opened from For you. */
export const logOpen = (target: Target) => logOnce('open', target);
