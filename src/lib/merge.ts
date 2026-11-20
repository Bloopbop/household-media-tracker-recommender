// Combining another phone's backup into this one (decided 20 November 2026).
// Until sync exists, Keith and Julie can each use their own phone: every few
// days a backup from one phone is combined into the other, then the other way
// round. Combining only adds; it never deletes.
//
// Rules:
// - Titles: the same id is the same title, since both phones start from one
//   restore. A title both phones added on their own, with the same TMDB id,
//   counts as one. Anything else is added. A title's details follow whichever
//   phone changed them last.
// - Ratings and statuses: whichever phone changed them last wins.
// - Watches and signals: added when this phone does not have them. Notes too,
//   with the newer text winning when both phones have the same note.
// - Settings, the vault import's records and slates are left alone.
// - Deleting does not carry over: something deleted on one phone comes back
//   from the other.
//
// The steps run on a connection where the other backup is attached as
// `other`, inside a savepoint: a preview rolls back, combining keeps it.

import type { Database } from '@sqlite.org/sqlite-wasm';

export interface MergeSummary {
  /** Titles this phone did not have. */
  titles: number;
  /** Titles whose details were changed later on the other phone. */
  details: number;
  ratings: number;
  statuses: number;
  watches: number;
  notes: number;
  /** All signals added, reactions included. */
  signals: number;
  /** Reactions among them (Want to watch, Seen it, Not tonight, Not interested). */
  reactions: number;
}

export const emptySummary = (): MergeSummary => ({
  titles: 0,
  details: 0,
  ratings: 0,
  statuses: 0,
  watches: 0,
  notes: 0,
  signals: 0,
  reactions: 0,
});

/** Each title in the other backup, and the title it is on this phone. */
const MAP = `
  CREATE TEMP TABLE merge_map (other_id TEXT PRIMARY KEY, local_id TEXT NOT NULL, fresh INTEGER NOT NULL);
  INSERT INTO temp.merge_map (other_id, local_id, fresh)
    SELECT o.id,
           COALESCE(
             (SELECT l.id FROM main.title l WHERE l.id = o.id),
             (SELECT l.id FROM main.title l WHERE o.tmdb_id IS NOT NULL AND l.kind = o.kind AND l.tmdb_id = o.tmdb_id),
             o.id),
           NOT EXISTS (
             SELECT 1 FROM main.title l
              WHERE l.id = o.id OR (o.tmdb_id IS NOT NULL AND l.kind = o.kind AND l.tmdb_id = o.tmdb_id))
      FROM other.title o;
`;

const REACTIONS = `
  SELECT COUNT(*) FROM other.signal o
   WHERE o.type IN ('watchlist', 'seen', 'not_tonight', 'not_interested')
     AND NOT EXISTS (SELECT 1 FROM main.signal s WHERE s.id = o.id)
`;

const STEPS: { name: Exclude<keyof MergeSummary, 'reactions'>; sql: string }[] = [
  {
    name: 'titles',
    sql: `
      INSERT INTO main.title (id, kind, name, year, tmdb_id, tmdb_checked_at, imdb_id, tvmaze_id, source, created_at, updated_at, source_ref)
        SELECT o.id, o.kind, o.name, o.year, o.tmdb_id, o.tmdb_checked_at, o.imdb_id, o.tvmaze_id, o.source, o.created_at,
               o.updated_at, o.source_ref
          FROM other.title o JOIN temp.merge_map m ON m.other_id = o.id
         WHERE m.fresh = 1`,
  },
  {
    // Not when the other phone's TMDB match belongs to a different title here.
    name: 'details',
    sql: `
      UPDATE main.title
         SET (kind, name, year, tmdb_id, tmdb_checked_at, imdb_id, tvmaze_id, updated_at) =
             (SELECT o.kind, o.name, o.year, o.tmdb_id, o.tmdb_checked_at, o.imdb_id, o.tvmaze_id, o.updated_at
                FROM other.title o WHERE o.id = title.id)
       WHERE EXISTS (
         SELECT 1 FROM other.title o
          WHERE o.id = title.id AND o.updated_at > title.updated_at
            AND (o.tmdb_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM main.title x WHERE x.kind = o.kind AND x.tmdb_id = o.tmdb_id AND x.id <> o.id)))`,
  },
  {
    name: 'ratings',
    sql: `
      INSERT INTO main.rating (rater, title_id, score, rated_at, source)
        SELECT o.rater, m.local_id, o.score, o.rated_at, o.source
          FROM other.rating o JOIN temp.merge_map m ON m.other_id = o.title_id
         WHERE true
      ON CONFLICT (rater, title_id) DO UPDATE SET score = excluded.score, rated_at = excluded.rated_at, source = excluded.source
       WHERE excluded.rated_at > rating.rated_at`,
  },
  {
    name: 'statuses',
    sql: `
      INSERT INTO main.title_state (profile_id, title_id, status, would_rewatch, updated_at)
        SELECT o.profile_id, m.local_id, o.status, o.would_rewatch, o.updated_at
          FROM other.title_state o JOIN temp.merge_map m ON m.other_id = o.title_id
         WHERE true
      ON CONFLICT (profile_id, title_id) DO UPDATE
         SET status = excluded.status, would_rewatch = excluded.would_rewatch, updated_at = excluded.updated_at
       WHERE excluded.updated_at > title_state.updated_at`,
  },
  {
    name: 'watches',
    sql: `
      INSERT OR IGNORE INTO main.watch_event (id, title_id, episode_id, participants, watched_on, completion, is_rewatch, source, created_at)
        SELECT o.id, m.local_id, o.episode_id, o.participants, o.watched_on, o.completion, o.is_rewatch, o.source, o.created_at
          FROM other.watch_event o JOIN temp.merge_map m ON m.other_id = o.title_id`,
  },
  {
    name: 'notes',
    sql: `
      INSERT INTO main.title_note (id, title_id, author, text, updated_at)
        SELECT o.id, m.local_id, o.author, o.text, o.updated_at
          FROM other.title_note o JOIN temp.merge_map m ON m.other_id = o.title_id
         WHERE true
      ON CONFLICT (id) DO UPDATE SET text = excluded.text, author = excluded.author, updated_at = excluded.updated_at
       WHERE excluded.updated_at > title_note.updated_at`,
  },
  {
    name: 'signals',
    sql: `
      INSERT OR IGNORE INTO main.signal (id, at, mode, type, title_key, title_id, slate_id, rank, session, arm)
        SELECT o.id, o.at, o.mode, o.type, o.title_key, COALESCE(m.local_id, o.title_id), o.slate_id, o.rank, o.session, o.arm
          FROM other.signal o LEFT JOIN temp.merge_map m ON m.other_id = o.title_id`,
  },
];

/**
 * Combines the attached `other` backup into this phone's data. With apply
 * false nothing changes: the counts say what combining would add.
 */
export function runMerge(database: Database, apply: boolean): MergeSummary {
  const summary = emptySummary();
  database.exec('SAVEPOINT merge');
  try {
    database.exec(MAP);
    summary.reactions = Number(database.selectValue(REACTIONS) ?? 0);
    for (const step of STEPS) {
      database.exec(step.sql);
      summary[step.name] = database.changes();
    }
    database.exec('DROP TABLE temp.merge_map');
    if (!apply) database.exec('ROLLBACK TO merge');
    database.exec('RELEASE merge');
  } catch (error) {
    database.exec('ROLLBACK TO merge');
    database.exec('RELEASE merge');
    throw error;
  }
  return summary;
}

/** Whether a summary has anything to add. */
export const hasNews = (summary: MergeSummary) =>
  Object.entries(summary).some(([key, value]) => key !== 'reactions' && value > 0);
