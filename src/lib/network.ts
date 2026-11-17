/**
 * True when the app's own site can be reached.
 *
 * `navigator.onLine` alone is not enough: it can stay true when the phone has
 * no working connection (seen on the Galaxy S24 in phase 0). So ask the site
 * for a small file, bypassing every cache. The query string keeps the service
 * worker from answering it.
 */
export async function checkNetwork(): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const probe = `${import.meta.env.BASE_URL}manifest.webmanifest?probe=${Date.now()}`;
    await fetch(probe, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}
