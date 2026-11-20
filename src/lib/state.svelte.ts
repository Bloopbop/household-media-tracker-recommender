// App-wide reactive state: profile names, configuration, and a counter that
// views watch so they reload after any change to household data.

import { getSetting, setSetting } from './db';
import type { Profiles } from './types';

export const app = $state({
  ready: false,
  error: '',
  /** Increments after every write to household data. */
  version: 0,
  profiles: { A: 'A', B: 'B' } as Profiles,
  tmdbKey: '',
  omdbKey: '',
  region: 'CA',
  online: navigator.onLine,
  /** Short status line from the background refresh, or ''. */
  refreshStatus: '',
  /** Vault import matching in progress, or null. */
  importProgress: null as { done: number; total: number } | null,
  /** Short status line from the recommender's background work, or ''. */
  recStatus: '',
  /** The last error from the recommender's background work, or ''. */
  recError: '',
  /** Increments whenever new slates are saved. */
  slatesVersion: 0,
  /** How long the last slate build took, in milliseconds. */
  lastSlateBuildMs: null as number | null,
  /** Milliseconds from opening the app to the first picks on screen, this session. */
  slateShownMs: null as number | null,
});

/** Identifies this run of the app on signals: one session from launch to close. */
export const SESSION_ID = crypto.randomUUID();

export function changed(): void {
  app.version++;
}

export function personName(id: 'A' | 'B' | 'US'): string {
  return id === 'US' ? 'Us' : app.profiles[id];
}

export function defaultRegion(): string {
  const match = /-([A-Za-z]{2})\b/.exec(navigator.language ?? '');
  return match ? match[1].toUpperCase() : 'US';
}

export async function loadConfig(): Promise<void> {
  app.tmdbKey = (await getSetting('tmdb_key')) ?? '';
  app.omdbKey = (await getSetting('omdb_key')) ?? '';
  app.region = (await getSetting('region')) ?? defaultRegion();
}

export async function saveConfig(values: { tmdbKey: string; omdbKey: string; region: string }): Promise<void> {
  const region = values.region.trim().toUpperCase().slice(0, 2) || defaultRegion();
  await setSetting('tmdb_key', values.tmdbKey.trim());
  await setSetting('omdb_key', values.omdbKey.trim());
  await setSetting('region', region);
  app.tmdbKey = values.tmdbKey.trim();
  app.omdbKey = values.omdbKey.trim();
  app.region = region;
}
