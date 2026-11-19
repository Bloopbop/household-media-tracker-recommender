// The database lives in a worker so the page never blocks on storage.
//
// Storage is SQLite on the origin private file system (OPFS), through the
// "SAH pool" file system, which needs no special HTTP headers (GitHub Pages
// cannot send them). household.db is the main database; cache.db is attached
// to the same connection as `cache`, so queries can join the two.
//
// Requests are handled strictly one at a time, in arrival order.

import sqlite3InitModule, { type Database, type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { CACHE_MIGRATIONS, DEVICE_ONLY_SETTINGS_SQL, HOUSEHOLD_MIGRATIONS } from './schema';

export interface DbOpenInfo {
  sqliteVersion: string;
  /** 'opfs' means data is on disk and should survive a restart. */
  storage: 'opfs' | 'memory';
  /** Why durable storage could not be opened, when storage is 'memory'. */
  storageError: string;
  files: string[];
  householdVersion: number;
}

export interface Statement {
  sql: string;
  bind?: unknown[];
}

export type DbRequest =
  | { id: number; op: 'open' }
  | { id: number; op: 'exec'; sql: string; bind: unknown[] }
  | { id: number; op: 'batch'; statements: Statement[] }
  | { id: number; op: 'exportHousehold' }
  | { id: number; op: 'importHousehold'; bytes: Uint8Array }
  | { id: number; op: 'clearCache' };

export type DbResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

const HOUSEHOLD = '/household.db';
const CACHE = '/cache.db';
const RESTORE_CHECK = '/restore-check.db';
const BACKUP_TEMP = '/backup-temp.db';
const SQLITE_HEADER = 'SQLite format 3\u0000';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

let sqlite3: Sqlite3 | undefined;
let pool: SAHPoolUtil | undefined;
let db: Database | undefined;
let openInfo: DbOpenInfo | undefined;

function requireDb(): Database {
  if (!db) throw new Error('Database is not open');
  return db;
}

const uri = (name: string) => (pool ? `file:${name}?vfs=${pool.vfsName}` : ':memory:');

function migrate(schema: 'main' | 'cache', migrations: string[]): number {
  const database = requireDb();
  const current = Number(database.selectValue(`PRAGMA ${schema}.user_version`) ?? 0);
  if (current > migrations.length) {
    throw new Error('This data was saved by a newer version of the app. Reload to update the app.');
  }
  for (let version = current; version < migrations.length; version++) {
    database.transaction(() => {
      database.exec(migrations[version]);
      database.exec(`PRAGMA ${schema}.user_version = ${version + 1}`);
    });
  }
  return migrations.length;
}

/** Opens household.db (or memory), attaches the cache and applies migrations. */
function connect(): number {
  if (!sqlite3) throw new Error('SQLite is not loaded');
  db = pool ? new pool.OpfsSAHPoolDb(HOUSEHOLD) : new sqlite3.oo1.DB(':memory:', 'c');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`ATTACH DATABASE '${uri(CACHE)}' AS cache`);
  const version = migrate('main', HOUSEHOLD_MIGRATIONS);
  migrate('cache', CACHE_MIGRATIONS);
  return version;
}

async function open(): Promise<DbOpenInfo> {
  if (openInfo) return openInfo;
  sqlite3 = await sqlite3InitModule();

  let storageError = '';
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({
      // A directory of our own, so other apps on the same origin cannot collide.
      directory: '/hmtr-sqlite',
      initialCapacity: 10,
    });
    // Household, cache, their journals, and temporary copies for backups.
    await pool.reserveMinimumCapacity(10);
  } catch (error) {
    // Usually: OPFS is unavailable, or the app is open in a second tab.
    storageError = error instanceof Error ? error.message : String(error);
    pool = undefined;
  }

  const householdVersion = connect();
  openInfo = {
    sqliteVersion: sqlite3.version.libVersion,
    storage: pool ? 'opfs' : 'memory',
    storageError,
    files: pool ? pool.getFileNames() : [],
    householdVersion,
  };
  return openInfo;
}

function exec(sql: string, bind: unknown[]): unknown {
  return requireDb().exec({
    sql,
    bind: bind.length ? (bind as never) : undefined,
    rowMode: 'object',
    returnValue: 'resultRows',
  });
}

/** Runs statements in one transaction: all of them apply, or none do. */
function batch(statements: Statement[]): number {
  const database = requireDb();
  let changes = 0;
  database.transaction(() => {
    for (const statement of statements) {
      database.exec({ sql: statement.sql, bind: statement.bind?.length ? (statement.bind as never) : undefined });
      changes += database.changes();
    }
  });
  return changes;
}

function requirePool(action: string): SAHPoolUtil {
  if (!pool) throw new Error(`Device storage is unavailable, so ${action} is not possible.`);
  return pool;
}

/**
 * A copy of household.db without device-only data: API keys, the device
 * check's records, and the launch counter.
 */
async function exportHousehold(): Promise<Uint8Array> {
  const storage = requirePool('a backup');
  await storage.importDb(BACKUP_TEMP, storage.exportFile(HOUSEHOLD));
  const copy = new storage.OpfsSAHPoolDb(BACKUP_TEMP);
  try {
    copy.exec('PRAGMA secure_delete = ON');
    copy.exec(`DELETE FROM settings WHERE ${DEVICE_ONLY_SETTINGS_SQL}`);
    copy.exec('DELETE FROM spike_boot');
    // Slates are rebuilt from the data and hold TMDB-derived text.
    copy.exec('DELETE FROM slate_item');
    copy.exec('DELETE FROM slate');
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
  const bytes = storage.exportFile(BACKUP_TEMP);
  storage.unlink(BACKUP_TEMP);
  return bytes;
}

function checkBackup(storage: SAHPoolUtil): void {
  const check = new storage.OpfsSAHPoolDb(RESTORE_CHECK);
  try {
    if (check.selectValue('PRAGMA quick_check') !== 'ok') throw new Error('The backup file is damaged.');
    const version = Number(check.selectValue('PRAGMA user_version') ?? 0);
    if (version > HOUSEHOLD_MIGRATIONS.length) {
      throw new Error('This backup was made by a newer version of the app. Reload to update the app first.');
    }
    const tables = check.selectValues("SELECT name FROM sqlite_schema WHERE type = 'table'") as string[];
    if (!tables.includes('settings')) throw new Error('This file is not a household backup.');
  } finally {
    check.close();
  }
}

/** Replaces household.db with a backup, keeping this device's own settings. */
async function importHousehold(bytes: Uint8Array): Promise<{ titles: number }> {
  const storage = requirePool('restoring a backup');
  const header = new TextDecoder().decode(bytes.subarray(0, 16));
  if (header !== SQLITE_HEADER) throw new Error('This file is not a household backup.');

  await storage.importDb(RESTORE_CHECK, bytes);
  try {
    checkBackup(storage);
  } finally {
    storage.unlink(RESTORE_CHECK);
  }

  const database = requireDb();
  const keep = database.exec({
    sql: `SELECT key, value FROM settings WHERE ${DEVICE_ONLY_SETTINGS_SQL}`,
    rowMode: 'array',
    returnValue: 'resultRows',
  }) as [string, string][];
  const launches = database.exec({
    sql: 'SELECT at, online, standalone FROM spike_boot ORDER BY id',
    rowMode: 'array',
    returnValue: 'resultRows',
  }) as [string, number, number][];

  database.exec('DETACH DATABASE cache');
  database.close();
  db = undefined;
  await storage.importDb(HOUSEHOLD, bytes);
  connect();

  batch([
    { sql: `DELETE FROM settings WHERE ${DEVICE_ONLY_SETTINGS_SQL}` },
    ...keep.map(([key, value]) => ({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?)', bind: [key, value] })),
    { sql: 'DELETE FROM spike_boot' },
    ...launches.map((row) => ({ sql: 'INSERT INTO spike_boot (at, online, standalone) VALUES (?, ?, ?)', bind: row })),
  ]);
  const titles = Number(requireDb().selectValue('SELECT COUNT(*) FROM title') ?? 0);
  return { titles };
}

/** Deletes everything fetched from outside, and the slates built from it. */
function clearCache(): void {
  batch([
    ...['tmdb_title', 'omdb_rating', 'fetch_failure', 'gateway_state', 'title_feature', 'pool', 'provider', 'omdb_wanted'].map(
      (table) => ({ sql: `DELETE FROM cache.${table}` }),
    ),
    { sql: 'DELETE FROM slate_item' },
    { sql: 'DELETE FROM slate' },
  ]);
}

async function handle(request: DbRequest): Promise<DbResponse> {
  try {
    switch (request.op) {
      case 'open':
        return { id: request.id, ok: true, result: await open() };
      case 'exec':
        return { id: request.id, ok: true, result: exec(request.sql, request.bind) };
      case 'batch':
        return { id: request.id, ok: true, result: batch(request.statements) };
      case 'exportHousehold':
        return { id: request.id, ok: true, result: await exportHousehold() };
      case 'importHousehold':
        return { id: request.id, ok: true, result: await importHousehold(request.bytes) };
      case 'clearCache':
        clearCache();
        return { id: request.id, ok: true, result: null };
    }
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const scope = self as unknown as { postMessage(message: DbResponse, transfer?: Transferable[]): void };
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<DbRequest>) => {
  queue = queue.then(async () => {
    const response = await handle(event.data);
    const transfer = response.ok && response.result instanceof Uint8Array ? [response.result.buffer as ArrayBuffer] : [];
    scope.postMessage(response, transfer);
  });
});
