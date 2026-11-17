// Page-side handle to the database worker: every call is a promise.

import type { DbOpenInfo, DbRequest, DbResponse } from './db.worker';

export type { DbOpenInfo };

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<DbResponse>) => {
    const response = event.data;
    const waiting = pending.get(response.id);
    if (!waiting) return;
    pending.delete(response.id);
    if (response.ok) waiting.resolve(response.result);
    else waiting.reject(new Error(response.error));
  });
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'The database worker failed to start');
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  });
  return worker;
}

type DbCall = { op: 'open' } | { op: 'exec'; sql: string; bind: unknown[] };

function call<T>(request: DbCall): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    getWorker().postMessage({ ...request, id } as DbRequest);
  });
}

export const openDb = () => call<DbOpenInfo>({ op: 'open' });

export const exec = <T = Record<string, unknown>>(sql: string, bind: unknown[] = []) =>
  call<T[]>({ op: 'exec', sql, bind });

export async function getSetting(key: string): Promise<string | undefined> {
  const rows = await exec<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return rows[0]?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await exec(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

export async function deleteSetting(key: string): Promise<void> {
  await exec('DELETE FROM settings WHERE key = ?', [key]);
}
