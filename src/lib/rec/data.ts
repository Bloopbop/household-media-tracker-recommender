// Loads what the recommender needs from the two databases, and the
// household's streaming services.

import { batch, exec, getSetting, setSetting } from '../db';
import { app } from '../state.svelte';
import type { Kind, OmdbScores, ProfileId, Rater, Status, TmdbTitle } from '../types';
import { FEATURE_VERSION, featureRow, type FeatureRow } from './features';
import { feedbackFrom, type SignalRow } from './feedback';
import { START_WEIGHTS, type LibraryTitle, type RecInput } from './types';

const parse = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/**
 * Builds feature rows for cached records that have none, or an older one.
 * Records saved since phase 2 get theirs when saved; this covers the rest.
 */
export async function ensureFeatures(): Promise<number> {
  const rows = await exec<{ key: string; data: string; fetched_at: number }>(
    `SELECT c.key, c.data, c.fetched_at FROM cache.tmdb_title c
       LEFT JOIN cache.title_feature f ON f.key = c.key
      WHERE (f.key IS NULL OR f.version < ?) AND IFNULL(json_extract(c.data, '$.version'), 1) >= 2`,
    [FEATURE_VERSION],
  );
  const statements = rows.flatMap((row) => {
    const feature = featureRow(parse<TmdbTitle | null>(row.data, null) ?? ({} as TmdbTitle));
    return feature
      ? [
          {
            sql: `INSERT INTO cache.title_feature (key, version, data, fetched_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT (key) DO UPDATE SET version = excluded.version, data = excluded.data, fetched_at = excluded.fetched_at`,
            bind: [row.key, FEATURE_VERSION, JSON.stringify(feature), row.fetched_at],
          },
        ]
      : [];
  });
  if (statements.length) await batch(statements);
  return statements.length;
}

// ------------------------------------------------------------- services

export interface ServiceChoice {
  region: string;
  ids: number[];
}

/** Provider ids the household subscribes to in the region, or null if none are chosen for it. */
export async function getServices(region: string): Promise<number[] | null> {
  const choice = parse<ServiceChoice | null>(await getSetting('services'), null);
  return choice && choice.region === region && choice.ids.length > 0 ? choice.ids : null;
}

/** What was ticked, even if nothing: for the Settings screen. */
export async function getServiceChoice(region: string): Promise<number[]> {
  const choice = parse<ServiceChoice | null>(await getSetting('services'), null);
  return choice && choice.region === region ? choice.ids : [];
}

export async function setServices(region: string, ids: number[]): Promise<void> {
  await setSetting('services', JSON.stringify({ region, ids: [...new Set(ids)].sort((a, b) => a - b) } satisfies ServiceChoice));
}

// ---------------------------------------------------------------- loading

interface LibraryRow {
  id: string;
  kind: Kind;
  name: string;
  tmdb_id: number | null;
  ratings: string | null;
  states: string | null;
  events: string | null;
}

/** The library, or only the titles with these keys (kind:tmdbId). */
export async function loadLibrary(keys?: string[]): Promise<LibraryTitle[]> {
  const only = keys
    ? `WHERE t.tmdb_id IS NOT NULL AND t.kind || ':' || t.tmdb_id IN (SELECT value FROM json_each(?))`
    : '';
  const rows = await exec<LibraryRow>(
    `
    SELECT t.id, t.kind, t.name, t.tmdb_id,
           (SELECT json_group_object(r.rater, json_object('score', r.score, 'at', r.rated_at))
              FROM rating r WHERE r.title_id = t.id) AS ratings,
           (SELECT json_group_object(s.profile_id, json_object('status', s.status, 'rewatch', s.would_rewatch, 'at', s.updated_at))
              FROM title_state s WHERE s.title_id = t.id) AS states,
           (SELECT json_group_array(json_object('participants', w.participants, 'completion', w.completion,
                                                'rewatch', w.is_rewatch, 'at', w.created_at))
              FROM watch_event w WHERE w.title_id = t.id) AS events
      FROM title t ${only}`,
    keys ? [JSON.stringify(keys)] : [],
  );
  return rows.map((row) => {
    const states = parse<Partial<Record<ProfileId, { status: Status | null; rewatch: number; at: number }>>>(row.states, {});
    const events = parse<{ participants: number; completion: number; rewatch: number; at: number }[]>(row.events, []);
    return {
      id: row.id,
      key: row.tmdb_id != null ? `${row.kind}:${row.tmdb_id}` : null,
      kind: row.kind,
      name: row.name,
      ratings: parse<Partial<Record<Rater, { score: number; at: number }>>>(row.ratings, {}),
      states: Object.fromEntries(
        Object.entries(states).map(([person, state]) => [person, { status: state.status, rewatch: Boolean(state.rewatch), at: state.at }]),
      ),
      events: events.map((event) => ({ participants: event.participants, completion: event.completion, isRewatch: Boolean(event.rewatch), at: event.at })),
    };
  });
}

/** Signals the next slates depend on: every reaction, and impressions recent enough for a fatigue rest. */
export async function loadSignals(now = Date.now()): Promise<SignalRow[]> {
  return exec<SignalRow>(
    `SELECT mode, type, title_key AS key, at FROM signal
      WHERE title_key IS NOT NULL AND (type <> 'impression' OR at >= ?)`,
    [now - 60 * 86_400_000],
  );
}

export async function loadRecInput(now = Date.now()): Promise<RecInput> {
  await ensureFeatures();
  const [library, featureRows, omdbRows, poolRows, services, signals] = await Promise.all([
    loadLibrary(),
    exec<{ data: string }>('SELECT data FROM cache.title_feature WHERE version = ?', [FEATURE_VERSION]),
    exec<{ key: string; data: string }>(
      `SELECT f.key, o.data FROM cache.title_feature f
         JOIN cache.omdb_rating o ON o.imdb_id = json_extract(f.data, '$.imdbId')`,
    ),
    exec<{ key: string; sources: string }>('SELECT key, sources FROM cache.pool'),
    getServices(app.region),
    loadSignals(now),
  ]);
  const features = new Map<string, FeatureRow>();
  for (const row of featureRows) {
    const feature = parse<FeatureRow | null>(row.data, null);
    if (feature) features.set(feature.key, feature);
  }
  const omdb = new Map<string, OmdbScores>();
  for (const row of omdbRows) {
    const scores = parse<OmdbScores | null>(row.data, null);
    if (scores) omdb.set(row.key, scores);
  }
  return {
    now,
    library,
    features,
    omdb,
    pool: new Map(poolRows.map((row) => [row.key, parse<string[]>(row.sources, [])])),
    region: app.region,
    services,
    names: { ...app.profiles },
    weights: START_WEIGHTS,
    feedback: feedbackFrom(signals, now),
  };
}
