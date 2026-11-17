// The database lives in a worker so the page never blocks on storage.
//
// Storage is SQLite on the origin private file system (OPFS), through the
// "SAH pool" file system. That variant needs no special HTTP headers, which
// matters because GitHub Pages cannot send them.

import sqlite3InitModule, { type Database, type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';

export interface DbOpenInfo {
  sqliteVersion: string;
  /** 'opfs' means data is on disk and should survive a restart. */
  storage: 'opfs' | 'memory';
  /** Why durable storage could not be opened, when storage is 'memory'. */
  storageError: string;
  files: string[];
}

export type DbRequest =
  | { id: number; op: 'open' }
  | { id: number; op: 'exec'; sql: string; bind: unknown[] };

export type DbResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spike_boot (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT    NOT NULL,
    online     INTEGER NOT NULL,
    standalone INTEGER NOT NULL
  );
`;

let db: Database | undefined;
let openInfo: DbOpenInfo | undefined;

async function open(): Promise<DbOpenInfo> {
  if (openInfo) return openInfo;

  const sqlite3 = await sqlite3InitModule();
  let storage: DbOpenInfo['storage'] = 'memory';
  let storageError = '';
  let pool: SAHPoolUtil | undefined;

  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({
      // A directory of our own, so other apps on the same origin cannot collide.
      directory: '/hmtr-sqlite',
      // Two database files (household and cache) plus their journals.
      initialCapacity: 8,
    });
    db = new pool.OpfsSAHPoolDb('/household.db');
    storage = 'opfs';
  } catch (error) {
    // Usually: OPFS is unavailable, or the app is open in a second tab.
    storageError = error instanceof Error ? error.message : String(error);
    db = new sqlite3.oo1.DB(':memory:', 'c');
  }

  db.exec(SCHEMA);
  openInfo = {
    sqliteVersion: sqlite3.version.libVersion,
    storage,
    storageError,
    files: pool ? pool.getFileNames() : [],
  };
  return openInfo;
}

function exec(sql: string, bind: unknown[]): unknown {
  if (!db) throw new Error('Database is not open');
  return db.exec({
    sql,
    bind: bind as never,
    rowMode: 'object',
    returnValue: 'resultRows',
  });
}

const post = (message: DbResponse) =>
  (self as unknown as { postMessage(message: DbResponse): void }).postMessage(message);

self.addEventListener('message', async (event: MessageEvent<DbRequest>) => {
  const request = event.data;
  try {
    const result = request.op === 'open' ? await open() : exec(request.sql, request.bind);
    post({ id: request.id, ok: true, result });
  } catch (error) {
    post({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
