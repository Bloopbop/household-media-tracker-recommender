// Page-side handle to the database worker: every call is a promise.

import type { DbOpenInfo, DbRequest, DbResponse, Statement } from './db.worker';
import type { MergeSummary } from './merge';

export type { DbOpenInfo, Statement };

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };
type DbCall = DbRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

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

function call<T>(request: DbCall, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    getWorker().postMessage({ ...request, id } as DbRequest, transfer);
  });
}

let opening: Promise<DbOpenInfo> | undefined;

/** Opens the databases once; later calls share the same result. */
export const openDb = () => (opening ??= call<DbOpenInfo>({ op: 'open' }));

export const exec = <T = Record<string, unknown>>(sql: string, bind: unknown[] = []) =>
  call<T[]>({ op: 'exec', sql, bind });

/** Runs statements in one transaction. Resolves to the number of rows changed. */
export const batch = (statements: Statement[]) => call<number>({ op: 'batch', statements });

export const exportHousehold = () => call<Uint8Array>({ op: 'exportHousehold' });

export const importHousehold = (bytes: Uint8Array) =>
  call<{ titles: number }>({ op: 'importHousehold', bytes }, [bytes.buffer as ArrayBuffer]);

/** Combines another phone's backup into this one; with apply false it only counts what would be added. */
export const mergeHousehold = (bytes: Uint8Array, apply: boolean) =>
  call<MergeSummary>({ op: 'mergeHousehold', bytes, apply }, [bytes.buffer as ArrayBuffer]);

export const clearCache = () => call<null>({ op: 'clearCache' });

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

/** Cache-side key-value state used by the gateway. */
export async function getGatewayState(key: string): Promise<string | undefined> {
  const rows = await exec<{ value: string }>('SELECT value FROM cache.gateway_state WHERE key = ?', [key]);
  return rows[0]?.value;
}

export async function setGatewayState(key: string, value: string): Promise<void> {
  await exec(
    'INSERT INTO cache.gateway_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}
