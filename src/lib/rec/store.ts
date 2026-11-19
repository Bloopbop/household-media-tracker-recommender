// Saved slates: the picks shown for each mode, rebuilt when the data they
// came from changes.

import { batch, exec, getSetting, setSetting } from '../db';
import type { Kind } from '../types';
import { MODEL_VERSION } from './engine';
import { MODES, START_WEIGHTS, type Components, type Evidence, type Mode, type SlatePick, type SlateResult } from './types';

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

export interface StoredSlate {
  id: string;
  mode: Mode;
  createdAt: number;
  stats: SlateStats;
  picks: SlatePick[];
  reserve: SlatePick[];
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
                                      availability, exploratory, rewatch, reserve, reason, evidence)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

function toPick(row: ItemRow): SlatePick {
  const evidence = JSON.parse(row.evidence) as Evidence & { display: Display };
  const components: Components = {};
  for (const name of ['content', 'collaborative', 'quality', 'partner'] as const) {
    if (row[name] != null) components[name] = row[name] as number;
  }
  return {
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

export async function loadSlate(mode: Mode): Promise<StoredSlate | null> {
  const [slate] = await exec<{ id: string; mode: Mode; created_at: number; stats: string }>(
    'SELECT id, mode, created_at, stats FROM slate WHERE mode = ? ORDER BY created_at DESC LIMIT 1',
    [mode],
  );
  if (!slate) return null;
  const rows = await exec<ItemRow>('SELECT * FROM slate_item WHERE slate_id = ? ORDER BY rank', [slate.id]);
  const picks = rows.map((row) => ({ row, pick: toPick(row) }));
  return {
    id: slate.id,
    mode: slate.mode,
    createdAt: slate.created_at,
    stats: JSON.parse(slate.stats) as SlateStats,
    picks: picks.filter((entry) => !entry.row.reserve).map((entry) => entry.pick),
    reserve: picks.filter((entry) => entry.row.reserve).map((entry) => entry.pick),
  };
}

/** The latest saved pick for a title in a mode, for Why this? */
export async function loadPick(mode: Mode, key: string): Promise<SlatePick | null> {
  const [row] = await exec<ItemRow>(
    `SELECT i.* FROM slate_item i JOIN slate s ON s.id = i.slate_id
      WHERE s.mode = ? AND i.title_key = ? ORDER BY s.created_at DESC LIMIT 1`,
    [mode, key],
  );
  return row ? toPick(row) : null;
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
