// Phase 0 checks: the assumptions that would force a platform change if false.
//
// Results report only statuses, counts and timings. They never include content
// returned by TMDB, so a results summary is safe to paste anywhere.

export type Status = 'pass' | 'fail' | 'warn' | 'todo';

export interface Outcome {
  status: Status;
  detail: string;
}

const ms = (since: number) => Math.round(performance.now() - since);
const kb = (bytes: number) => Math.round(bytes / 1024);

function describeError(error: unknown): string {
  if (!navigator.onLine) return 'the device is offline';
  if (error instanceof TypeError) return 'request blocked or unreachable (network or cross-origin rules)';
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- environment

/**
 * True when the app's own site cannot be reached.
 *
 * `navigator.onLine` alone is not enough: it can stay true when the phone is
 * joined to a network with no working connection. So ask the site for a small
 * file, bypassing every cache. The query string keeps the service worker from
 * answering it.
 */
export async function hasNoNetwork(): Promise<boolean> {
  if (!navigator.onLine) return true;
  try {
    const probe = `${import.meta.env.BASE_URL}manifest.webmanifest?probe=${Date.now()}`;
    await fetch(probe, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return false;
  } catch {
    return true;
  }
}

export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || matchMedia('(display-mode: standalone)').matches;
}

export function checkInstall(): Outcome {
  return isStandalone()
    ? { status: 'pass', detail: 'Running as an installed app.' }
    : { status: 'todo', detail: 'Running in a browser tab. Add the app to the home screen, then open it from there.' };
}

export async function checkServiceWorker(): Promise<Outcome> {
  if (!window.isSecureContext) return { status: 'fail', detail: 'Not a secure (HTTPS) page.' };
  if (!('serviceWorker' in navigator)) return { status: 'fail', detail: 'Service workers are not supported.' };
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return { status: 'todo', detail: 'Offline support is still installing. Reload once.' };
  return navigator.serviceWorker.controller
    ? { status: 'pass', detail: 'The offline shell is installed and in control of this page.' }
    : { status: 'todo', detail: 'Offline support is installed. Reload once so it takes control.' };
}

// -------------------------------------------------------------------- storage

export async function checkPersistence(request: boolean): Promise<Outcome> {
  if (!navigator.storage?.persisted) return { status: 'fail', detail: 'The storage persistence API is missing.' };
  let persisted = await navigator.storage.persisted();
  if (!persisted && request && navigator.storage.persist) persisted = await navigator.storage.persist();
  const estimate = await navigator.storage.estimate();
  const usage = `${kb(estimate.usage ?? 0)} KB used of about ${Math.round((estimate.quota ?? 0) / 1024 / 1024)} MB`;
  return persisted
    ? { status: 'pass', detail: `The browser has promised not to evict this app's data. ${usage}.` }
    : { status: 'warn', detail: `Not granted yet: the browser may evict data under pressure. ${usage}.` };
}

// ----------------------------------------------------------------------- APIs

const TMDB_SECTIONS = ['credits', 'keywords', 'external_ids', 'recommendations', 'similar', 'watch/providers'];

/** TMDB issues two credentials: a short v3 key and a long v4 token. Accept either. */
const looksLikeBearerToken = (key: string) => key.length > 60 && key.includes('.');

export async function checkTmdb(key: string, region: string): Promise<Outcome & { posterPath?: string }> {
  if (!key) return { status: 'todo', detail: 'Enter a TMDB key.' };
  const url = new URL('https://api.themoviedb.org/3/movie/550');
  url.searchParams.set('append_to_response', TMDB_SECTIONS.join(','));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (looksLikeBearerToken(key)) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  const started = performance.now();
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const hint = response.status === 401 ? ' (key rejected)' : response.status === 429 ? ' (rate limited)' : '';
      return { status: 'fail', detail: `HTTP ${response.status}${hint}.` };
    }
    const data = (await response.json()) as Record<string, unknown>;
    const missing = TMDB_SECTIONS.filter((section) => !(section in data));
    const providers = data['watch/providers'] as { results?: Record<string, unknown> } | undefined;
    const regions = Object.keys(providers?.results ?? {});
    const hasRegion = regions.includes(region);
    const detail =
      `HTTP 200 in ${ms(started)} ms. Sections returned in one call: ${TMDB_SECTIONS.length - missing.length} of ${TMDB_SECTIONS.length}. ` +
      `Availability covers ${regions.length} regions; ${region} is ${hasRegion ? 'included' : 'missing'}.`;
    return {
      status: missing.length > 0 ? 'fail' : hasRegion ? 'pass' : 'warn',
      detail,
      posterPath: typeof data.poster_path === 'string' ? data.poster_path : undefined,
    };
  } catch (error) {
    return { status: 'fail', detail: `No response: ${describeError(error)}.` };
  }
}

export async function checkOmdb(key: string): Promise<Outcome> {
  if (!key) return { status: 'todo', detail: 'Enter an OMDb key.' };
  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('i', 'tt0137523');
  url.searchParams.set('apikey', key);

  const started = performance.now();
  try {
    const response = await fetch(url);
    const data = (await response.json().catch(() => ({}))) as {
      Response?: string;
      Error?: string;
      Ratings?: { Source?: string }[];
    };
    if (!response.ok || data.Response !== 'True') {
      return { status: 'fail', detail: `HTTP ${response.status}. ${data.Error ?? 'No usable answer.'}` };
    }
    const sources = new Set((data.Ratings ?? []).map((rating) => rating.Source));
    const present = (name: string) => (sources.has(name) ? 'yes' : 'no');
    const all = ['Internet Movie Database', 'Rotten Tomatoes', 'Metacritic'].every((name) => sources.has(name));
    return {
      status: all ? 'pass' : 'warn',
      detail:
        `HTTP 200 in ${ms(started)} ms. Scores present: IMDb ${present('Internet Movie Database')}, ` +
        `Rotten Tomatoes ${present('Rotten Tomatoes')}, Metacritic ${present('Metacritic')}.`,
    };
  } catch (error) {
    return { status: 'fail', detail: `No response: ${describeError(error)}.` };
  }
}

export async function checkTvmaze(): Promise<Outcome> {
  const started = performance.now();
  try {
    // The lookup answers with a redirect to the show; the browser follows it.
    const lookup = await fetch('https://api.tvmaze.com/lookup/shows?imdb=tt0903747');
    if (!lookup.ok) return { status: 'fail', detail: `Lookup returned HTTP ${lookup.status}.` };
    const show = (await lookup.json()) as { id?: number };
    if (typeof show.id !== 'number') return { status: 'fail', detail: 'Lookup returned no show id.' };

    const full = await fetch(`https://api.tvmaze.com/shows/${show.id}?embed[]=episodes&embed[]=nextepisode`);
    if (!full.ok) return { status: 'fail', detail: `Show request returned HTTP ${full.status}.` };
    const data = (await full.json()) as { _embedded?: { episodes?: unknown[] } };
    const episodes = data._embedded?.episodes?.length ?? 0;
    return episodes > 0
      ? { status: 'pass', detail: `Lookup redirect followed; ${episodes} episodes returned in ${ms(started)} ms.` }
      : { status: 'fail', detail: 'The show came back without its episode list.' };
  } catch (error) {
    return { status: 'fail', detail: `No response: ${describeError(error)}.` };
  }
}

// -------------------------------------------------------------------- posters

const POSTER_CACHE = 'hmtr-posters-v1';

export const posterUrl = (path: string) => `https://image.tmdb.org/t/p/w342${path}`;

export async function cachePoster(url: string): Promise<Outcome> {
  try {
    // 'cors' mode matters: an opaque response would be padded to several MB
    // each in the browser's storage accounting.
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return { status: 'fail', detail: `The image host returned HTTP ${response.status}.` };
    const size = (await response.clone().blob()).size;
    const cache = await caches.open(POSTER_CACHE);
    await cache.put(url, response);
    return response.type === 'cors'
      ? { status: 'pass', detail: `Fetched as a readable cross-origin response and cached (${kb(size)} KB).` }
      : { status: 'fail', detail: `Fetched as a '${response.type}' response, which cannot be cached cheaply.` };
  } catch (error) {
    return { status: 'fail', detail: `Could not fetch the image: ${describeError(error)}.` };
  }
}

/** Returns an object URL for the cached poster, or undefined if it is not cached. */
export async function readCachedPoster(url: string): Promise<string | undefined> {
  if (!('caches' in window)) return undefined;
  const cache = await caches.open(POSTER_CACHE);
  const hit = await cache.match(url);
  return hit ? URL.createObjectURL(await hit.blob()) : undefined;
}

export async function clearPosterCache(): Promise<void> {
  if ('caches' in window) await caches.delete(POSTER_CACHE);
}
