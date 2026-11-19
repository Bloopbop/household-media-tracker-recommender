// Saved slates: the picks shown for each mode, rebuilt when the data they
// came from changes.

import { batch, exec, getSetting, setSetting } from '../db';
import type { Kind, ProfileId } from '../types';
import { loadLibrary } from './data';
import { eligibility, EXPLORATORY_POSITIONS, MODEL_VERSION, SLATE_SIZE } from './engine';
import { NOT_TONIGHT_DAYS } from './feedback';
import { arrange } from './interleave';
import { peopleIn } from './profile';
import { MODES, START_WEIGHTS, type Arm, type Components, type Evidence, type Mode, type SlatePick, type SlateResult } from './types';

/** Changes whenever anything a slate depends on changes. */
export async function dataFingerprint(region: string): Promise<string> {
  const [row] = await exec<{ fp: string }>(
    `SELECT (SELECT COUNT(*) || ':' || IFNULL(MAX(rated_at), 0) || ':' || IFNULL(SUM(score), 0) FROM rating) || '|' ||
            (SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), 0) FROM title_state) || '|' ||
            (SELECT COUNT(*) || ':' || IFNULL(MAX(created_at), 0) FROM watch_event) || '|' ||
            (SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), 0) FROM title) || '|' ||
            (SELECT IFNULL(group_concat(name, ','), '') FROM profile) || '|' ||
            (SELECT COUNT(*) || ':' || IFNULL(MAX(fetched_at), 0) FROM cache.title_feature) || '|' ||
            (SELECT COUNT(*) || ':' || IFNULL(MAX(fetched_at), 0) FROM cache.omdb_rating) || '|' ||
            (SELECT COUNT(*) || ':' || IFNULL(MAX(listed_at), 0) FROM cache.pool) || '|' ||
            (SELECT IFNULL(MAX(value), '') FROM settings WHERE key = 'services') AS fp`,
  );
  return `${row.fp}|${region}|${MODEL_VERSION}`;
}

export interface SlateStats {
  candidates: number;
  ratings: number;
  coldProfile: boolean;
  /** Time to load the data and build all three slates, in milliseconds. */
  buildMs: number;
}

/** A pick as saved: where it sits in which slate. */
export interface StoredPick extends SlatePick {
  slateId: string;
  /** Its place in the saved slate (visible picks first, then reserves). */
  rank: number;
  /** People in the mode who have it on their Want to watch list now (watchlists are candidates too). */
  listedBy: ProfileId[];
}

export interface StoredSlate {
  id: string;
  mode: Mode;
  createdAt: number;
  stats: SlateStats;
  /** What to show now: picks that left (reactions, changes in the library) replaced from the reserve. */
  picks: StoredPick[];
  reserve: StoredPick[];
}

interface Display {
  kind: Kind;
  name: string;
  year: number | null;
  posterPath: string | null;
}

export async function saveSlates(results: SlateResult[], fingerprint: string, buildMs: number): Promise<void> {
  const at = Date.now();
  const statements = results.flatMap((result) => {
    const id = crypto.randomUUID();
    const stats: SlateStats = {
      candidates: result.stats.candidates,
      ratings: result.stats.ratings,
      coldProfile: result.stats.coldProfile,
      buildMs,
    };
    const items = [...result.picks.map((pick) => ({ pick, reserve: false })), ...result.reserve.map((pick) => ({ pick, reserve: true }))];
    return [
      {
        sql: 'INSERT INTO slate (id, mode, model_version, weights, built_from, stats, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        bind: [id, result.mode, MODEL_VERSION, JSON.stringify(START_WEIGHTS), fingerprint, JSON.stringify(stats), at],
      },
      ...items.map(({ pick, reserve }, index) => ({
        sql: `INSERT INTO slate_item (slate_id, rank, title_key, title_id, score, content, collaborative, quality, partner,
                                      availability, exploratory, rewatch, reserve, reason, evidence, arm)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          id,
          index + 1,
          pick.key,
          pick.titleId,
          pick.score,
          pick.components.content ?? null,
          pick.components.collaborative ?? null,
          pick.components.quality ?? null,
          pick.components.partner ?? null,
          pick.availability,
          pick.exploratory ? 1 : 0,
          pick.rewatch ? 1 : 0,
          reserve ? 1 : 0,
          pick.reason,
          JSON.stringify({ ...pick.evidence, display: { kind: pick.kind, name: pick.name, year: pick.year, posterPath: pick.posterPath } }),
          pick.arm,
        ],
      })),
    ];
  });
  // Keep the last slate of each day per mode: enough history for the monthly
  // quality check without one copy per rebuild.
  statements.push({
    sql: `DELETE FROM slate WHERE id IN (
            SELECT s.id FROM slate s
             WHERE EXISTS (SELECT 1 FROM slate t
                            WHERE t.mode = s.mode AND t.created_at > s.created_at
                              AND date(t.created_at / 1000, 'unixepoch', 'localtime') = date(s.created_at / 1000, 'unixepoch', 'localtime')))`,
    bind: [],
  });
  await batch(statements);
}

/** The best-scoring candidates outside the library, for OMDb review scores. */
export async function saveOmdbWanted(keys: string[]): Promise<void> {
  await batch([
    { sql: 'DELETE FROM cache.omdb_wanted' },
    {
      sql: `INSERT OR IGNORE INTO cache.omdb_wanted (key, imdb_id, rank)
            SELECT f.key, json_extract(f.data, '$.imdbId'), j.key
              FROM json_each(?) j JOIN cache.title_feature f ON f.key = j.value
             WHERE json_extract(f.data, '$.imdbId') IS NOT NULL`,
      bind: [JSON.stringify(keys)],
    },
  ]);
}

interface ItemRow {
  arm: Arm | null;
  slate_id: string;
  rank: number;
  title_key: string;
  title_id: string | null;
  score: number;
  content: number | null;
  collaborative: number | null;
  quality: number | null;
  partner: number | null;
  availability: number;
  exploratory: number;
  rewatch: number;
  reserve: number;
  reason: string;
  evidence: string;
}

function toPick(row: ItemRow): StoredPick {
  const evidence = JSON.parse(row.evidence) as Evidence & { display: Display };
  const components: Components = {};
  for (const name of ['content', 'collaborative', 'quality', 'partner'] as const) {
    if (row[name] != null) components[name] = row[name] as number;
  }
  return {
    slateId: row.slate_id,
    rank: row.rank,
    listedBy: [],
    arm: row.arm ?? (row.exploratory ? 'explore' : 'model'),
    key: row.title_key,
    titleId: row.title_id,
    kind: evidence.display.kind,
    name: evidence.display.name,
    year: evidence.display.year,
    posterPath: evidence.display.posterPath,
    score: row.score,
    components,
    availability: row.availability,
    exploratory: Boolean(row.exploratory),
    rewatch: Boolean(row.rewatch),
    reason: row.reason,
    evidence,
  };
}

/**
 * Keys to leave out of a mode's slate now, though it was built with them:
 * anything reacted to in this slate, Not tonight in the last 14 days,
 * Together's Not interested, and titles the library now rules out (watched,
 * on the list, not interested, dropped, in progress).
 */
async function hiddenNow(
  mode: Mode,
  slateId: string,
  keys: string[],
  now = Date.now(),
): Promise<{ hidden: Set<string>; listed: Map<string, ProfileId[]> }> {
  const [reacted, library] = await Promise.all([
    exec<{ key: string }>(
      `SELECT DISTINCT title_key AS key FROM signal
        WHERE mode = ? AND title_key IS NOT NULL AND type IN ('watchlist', 'seen', 'not_tonight', 'not_interested')
          AND (slate_id = ? OR (type = 'not_tonight' AND at >= ?) OR (type = 'not_interested' AND mode = 'US'))`,
      [mode, slateId, now - NOT_TONIGHT_DAYS * 86_400_000],
    ),
    loadLibrary(keys),
  ]);
  const hidden = new Set(reacted.map((row) => row.key));
  const listed = new Map<string, ProfileId[]>();
  for (const title of library) {
    if (!title.key) continue;
    if (eligibility(title, mode).type === 'excluded') hidden.add(title.key);
    const people = peopleIn(mode).filter((person) => title.states[person]?.status === 'watchlist');
    if (people.length) listed.set(title.key, people);
  }
  return { hidden, listed };
}

export async function loadSlate(mode: Mode): Promise<StoredSlate | null> {
  const [slate] = await exec<{ id: string; mode: Mode; created_at: number; stats: string }>(
    'SELECT id, mode, created_at, stats FROM slate WHERE mode = ? ORDER BY created_at DESC LIMIT 1',
    [mode],
  );
  if (!slate) return null;
  const rows = await exec<ItemRow>('SELECT * FROM slate_item WHERE slate_id = ? ORDER BY rank', [slate.id]);
  const items = rows.map(toPick);
  const { hidden, listed } = await hiddenNow(mode, slate.id, items.map((item) => item.key));
  for (const item of items) item.listedBy = listed.get(item.key) ?? [];
  const picks = arrange(items, hidden, SLATE_SIZE, EXPLORATORY_POSITIONS);
  const shown = new Set(picks.map((pick) => pick.key));
  return {
    id: slate.id,
    mode: slate.mode,
    createdAt: slate.created_at,
    stats: JSON.parse(slate.stats) as SlateStats,
    picks,
    reserve: items.filter((item) => !shown.has(item.key) && !hidden.has(item.key)),
  };
}

/** The latest saved pick for a title in a mode, for Why this? */
export async function loadPick(mode: Mode, key: string): Promise<StoredPick | null> {
  const [row] = await exec<ItemRow>(
    `SELECT i.* FROM slate_item i JOIN slate s ON s.id = i.slate_id
      WHERE s.mode = ? AND i.title_key = ? ORDER BY s.created_at DESC LIMIT 1`,
    [mode, key],
  );
  if (!row) return null;
  const pick = toPick(row);
  const [title] = await loadLibrary([key]);
  pick.listedBy = title ? peopleIn(mode).filter((person) => title.states[person]?.status === 'watchlist') : [];
  return pick;
}

/** Whether every mode's latest slate was built today (local time): picks change at most daily unless the data does. */
export async function slatesBuiltToday(now = Date.now()): Promise<boolean> {
  const rows = await exec<{ day: string }>(
    `SELECT date(MAX(created_at) / 1000, 'unixepoch', 'localtime') AS day FROM slate GROUP BY mode`,
  );
  const [today] = await exec<{ day: string }>(`SELECT date(? / 1000, 'unixepoch', 'localtime') AS day`, [now]);
  return rows.length === MODES.length && rows.every((row) => row.day === today.day);
}

/**
 * After a reaction, marks the current slates as built from the data as it now
 * is: the reaction already took the pick off the slate, so it should not
 * reshuffle the whole list. Tomorrow's slates take it into account.
 */
export async function absorbChange(before: string, after: string): Promise<void> {
  if (before !== after) await exec('UPDATE slate SET built_from = ? WHERE built_from = ?', [after, before]);
}

export async function latestFingerprint(): Promise<string | null> {
  const rows = await exec<{ mode: Mode; built_from: string }>(
    `SELECT mode, built_from FROM slate s WHERE created_at = (SELECT MAX(created_at) FROM slate WHERE mode = s.mode)`,
  );
  if (rows.length < MODES.length) return null;
  const prints = new Set(rows.map((row) => row.built_from));
  return prints.size === 1 ? [...prints][0] : null;
}

/** The mode last shown on this device. */
export async function getLastMode(): Promise<Mode> {
  const value = await getSetting('rec_mode');
  return value === 'A' || value === 'B' || value === 'US' ? value : 'US';
}

export async function setLastMode(mode: Mode): Promise<void> {
  await setSetting('rec_mode', mode);
}

export interface CandidateDetail {
  tmdb: import('../types').TmdbTitle | null;
  tmdbFetchedAt: number | null;
  omdb: import('../types').OmdbScores | null;
  omdbFetchedAt: number | null;
  /** The library title, when the household already has this one. */
  titleId: string | null;
}

/** Everything cached about a candidate, for its page. */
export async function loadCandidate(key: string): Promise<CandidateDetail> {
  const [kind, id] = key.split(':');
  const [row] = await exec<{ data: string; fetched_at: number }>('SELECT data, fetched_at FROM cache.tmdb_title WHERE key = ?', [key]);
  const tmdb = row ? (JSON.parse(row.data) as import('../types').TmdbTitle) : null;
  const [omdb] = tmdb?.imdbId
    ? await exec<{ data: string; fetched_at: number }>('SELECT data, fetched_at FROM cache.omdb_rating WHERE imdb_id = ?', [tmdb.imdbId])
    : [];
  const [title] = await exec<{ id: string }>('SELECT id FROM title WHERE kind = ? AND tmdb_id = ?', [kind, Number(id)]);
  return {
    tmdb,
    tmdbFetchedAt: row?.fetched_at ?? null,
    omdb: omdb ? (JSON.parse(omdb.data) as import('../types').OmdbScores | null) : null,
    omdbFetchedAt: omdb?.fetched_at ?? null,
    titleId: title?.id ?? null,
  };
}
