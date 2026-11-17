// Posters are cached by the service worker (see vite.config.ts): the first
// time an image is shown or prefetched it is stored, and it expires after
// POSTER_MAX_AGE_DAYS. Requests are made in CORS mode so the stored copies
// are readable and not padded to megabytes each in the storage accounting.

import { Limiter } from './limiter';
import { posterUrl } from './tmdb';

export const POSTER_CACHE = 'tmdb-posters';
const imageLimiter = new Limiter(100, 4);

/** Fetches posters not yet cached, so they show offline. Returns how many were fetched. */
export async function prefetchPosters(paths: string[], limit = 200): Promise<number> {
  if (!('caches' in window) || !navigator.serviceWorker?.controller) return 0;
  const cache = await caches.open(POSTER_CACHE);
  const missing: string[] = [];
  for (const path of new Set(paths)) {
    const url = posterUrl(path);
    if (!(await cache.match(url))) missing.push(url);
    if (missing.length >= limit) break;
  }
  const results = await Promise.allSettled(
    missing.map((url) => imageLimiter.run(() => fetch(url, { mode: 'cors' }).then((response) => response.ok))),
  );
  return results.filter((result) => result.status === 'fulfilled' && result.value).length;
}

export async function clearPosters(): Promise<void> {
  if ('caches' in window) await caches.delete(POSTER_CACHE);
}
