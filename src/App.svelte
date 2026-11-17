<script lang="ts">
  import { onMount } from 'svelte';
  import { deleteSetting, exec, getSetting, openDb, setSetting } from './lib/db';
  import {
    cachePoster,
    checkInstall,
    checkOmdb,
    checkPersistence,
    checkServiceWorker,
    checkTmdb,
    checkTvmaze,
    clearPosterCache,
    isStandalone,
    posterUrl,
    readCachedPoster,
    type Outcome,
    type Status,
  } from './lib/checks';

  interface Check extends Outcome {
    id: string;
    group: string;
    label: string;
  }

  const GROUPS = ['Setup', 'Storage', 'Services', 'Offline'];
  const STATUS_WORD: Record<Status, string> = { pass: 'Pass', fail: 'Fail', warn: 'Check', todo: 'To do' };
  // Outcomes of the online checks are kept, so the summary is still complete
  // when the app is later opened with no network.
  const REMEMBERED = ['tmdb', 'omdb', 'tvmaze', 'poster'];

  const waiting = (detail: string): Outcome => ({ status: 'todo', detail });

  let checks = $state<Check[]>([
    { id: 'install', group: 'Setup', label: 'Installed to the home screen', ...waiting('Checking…') },
    { id: 'shell', group: 'Setup', label: 'Offline shell installed', ...waiting('Checking…') },
    { id: 'sqlite', group: 'Storage', label: 'Database opens on device storage', ...waiting('Checking…') },
    { id: 'restart', group: 'Storage', label: 'Data survives closing the app', ...waiting('Checking…') },
    { id: 'persist', group: 'Storage', label: 'Storage protected from eviction', ...waiting('Checking…') },
    { id: 'tmdb', group: 'Services', label: 'TMDB reachable from this browser', ...waiting('Enter the keys and run the online checks.') },
    { id: 'omdb', group: 'Services', label: 'OMDb reachable from this browser', ...waiting('Enter the keys and run the online checks.') },
    { id: 'tvmaze', group: 'Services', label: 'TVmaze reachable from this browser', ...waiting('Run the online checks.') },
    { id: 'poster', group: 'Services', label: 'Poster fetched and cached', ...waiting('Needs a successful TMDB check first.') },
    { id: 'offline', group: 'Offline', label: 'App opens with no network', ...waiting('Turn on airplane mode, close the app completely, and reopen it.') },
    { id: 'posterOffline', group: 'Offline', label: 'Cached poster shows with no network', ...waiting('Run the online checks first, then reopen in airplane mode.') },
  ]);

  let tmdbKey = $state('');
  let omdbKey = $state('');
  let region = $state(defaultRegion());
  let posterSrc = $state<string | undefined>();
  let launches = $state(0);
  let dbReady = $state(false);
  let busy = $state(false);
  let online = $state(navigator.onLine);
  let summaryOpen = $state(false);
  let copied = $state(false);
  let resetArmed = $state(false);

  function defaultRegion(): string {
    const match = /-([A-Za-z]{2})\b/.exec(navigator.language ?? '');
    return match ? match[1].toUpperCase() : 'US';
  }

  const when = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';

  async function record(id: string, outcome: Outcome) {
    const check = checks.find((item) => item.id === id);
    if (!check) return;
    check.status = outcome.status;
    check.detail = outcome.detail;
    if (dbReady && REMEMBERED.includes(id)) {
      await setSetting(`result_${id}`, JSON.stringify({ status: outcome.status, detail: outcome.detail }));
    }
  }

  async function start() {
    await record('install', checkInstall());
    await record('shell', await checkServiceWorker());

    try {
      const info = await openDb();
      dbReady = true;
      await record(
        'sqlite',
        info.storage === 'opfs'
          ? { status: 'pass', detail: `SQLite ${info.sqliteVersion} is running on the browser's private file system.` }
          : { status: 'fail', detail: `Durable storage is unavailable, so data is in memory only. ${info.storageError}` },
      );

      await exec('INSERT INTO spike_boot (at, online, standalone) VALUES (?, ?, ?)', [
        new Date().toISOString(),
        navigator.onLine ? 1 : 0,
        isStandalone() ? 1 : 0,
      ]);
      const [row] = await exec<{ n: number; first: string; previous: string | null }>(
        `SELECT COUNT(*) AS n,
                MIN(at) AS first,
                (SELECT at FROM spike_boot ORDER BY id DESC LIMIT 1 OFFSET 1) AS previous
           FROM spike_boot`,
      );
      launches = Number(row.n);
      if (info.storage !== 'opfs') {
        await record('restart', { status: 'fail', detail: 'Nothing is being saved to the device.' });
      } else if (launches >= 2) {
        await record('restart', {
          status: 'pass',
          detail: `Launch ${launches}. First launch ${when(row.first)}; previous launch ${when(row.previous)}.`,
        });
      } else {
        await record('restart', waiting('First launch recorded. Close the app completely, reopen it, and this turns to Pass.'));
      }

      tmdbKey = (await getSetting('tmdb_key')) ?? '';
      omdbKey = (await getSetting('omdb_key')) ?? '';
      region = (await getSetting('region')) ?? region;
      for (const id of REMEMBERED) {
        const saved = await getSetting(`result_${id}`);
        if (saved) await record(id, JSON.parse(saved) as Outcome);
      }

      await checkOfflineState();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await record('sqlite', { status: 'fail', detail: `The database did not start. ${detail}` });
      await record('restart', { status: 'fail', detail: 'Nothing is being saved to the device.' });
    }

    await record('persist', await checkPersistence(false));
  }

  async function checkOfflineState() {
    const now = new Date().toISOString();
    if (!navigator.onLine) await setSetting('offline_seen', now);
    const offlineSeen = await getSetting('offline_seen');
    if (offlineSeen) await record('offline', { status: 'pass', detail: `Opened with no network on ${when(offlineSeen)}.` });

    const url = await getSetting('poster_url');
    if (url) posterSrc = await readCachedPoster(url);
    if (posterSrc && !navigator.onLine) await setSetting('poster_offline_seen', now);
    const posterSeen = await getSetting('poster_offline_seen');
    if (posterSeen) {
      await record('posterOffline', { status: 'pass', detail: `Shown from the cache with no network on ${when(posterSeen)}.` });
    }
  }

  async function runOnlineChecks() {
    busy = true;
    try {
      const cleanRegion = region.trim().toUpperCase() || 'US';
      region = cleanRegion;
      if (dbReady) {
        await setSetting('tmdb_key', tmdbKey.trim());
        await setSetting('omdb_key', omdbKey.trim());
        await setSetting('region', cleanRegion);
      }

      const tmdb = await checkTmdb(tmdbKey.trim(), cleanRegion);
      await record('tmdb', { status: tmdb.status, detail: tmdb.detail });
      await record('omdb', await checkOmdb(omdbKey.trim()));
      await record('tvmaze', await checkTvmaze());

      if (tmdb.posterPath) {
        const url = posterUrl(tmdb.posterPath);
        const cached = await cachePoster(url);
        await record('poster', cached);
        if (cached.status === 'pass') {
          if (dbReady) await setSetting('poster_url', url);
          posterSrc = await readCachedPoster(url);
        }
      } else {
        await record('poster', waiting('Needs a successful TMDB check first.'));
      }
    } finally {
      busy = false;
    }
  }

  async function requestPersistence() {
    await record('persist', await checkPersistence(true));
  }

  function summary(): string {
    const lines = [
      `Phase 0 results, ${new Date().toISOString()}`,
      `Device: ${navigator.userAgent}`,
      `Installed: ${isStandalone() ? 'yes' : 'no'}; launches recorded: ${launches}; online now: ${navigator.onLine ? 'yes' : 'no'}`,
      '',
      ...checks.map((check) => `[${STATUS_WORD[check.status].toUpperCase()}] ${check.label}: ${check.detail}`),
    ];
    return lines.join('\n');
  }

  async function copySummary() {
    summaryOpen = true;
    try {
      await navigator.clipboard.writeText(summary());
      copied = true;
      setTimeout(() => (copied = false), 2500);
    } catch {
      copied = false; // The text stays visible below for manual copying.
    }
  }

  async function resetTestData() {
    if (!resetArmed) {
      resetArmed = true;
      setTimeout(() => (resetArmed = false), 4000);
      return;
    }
    if (dbReady) {
      await exec('DELETE FROM spike_boot');
      for (const key of ['offline_seen', 'poster_offline_seen', 'poster_url', ...REMEMBERED.map((id) => `result_${id}`)]) {
        await deleteSetting(key);
      }
    }
    await clearPosterCache();
    location.reload();
  }

  const passed = $derived(checks.filter((check) => check.status === 'pass').length);

  onMount(() => {
    const update = () => (online = navigator.onLine);
    addEventListener('online', update);
    addEventListener('offline', update);
    void start();
    return () => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    };
  });
</script>

<main>
  <header>
    <p class="eyebrow">Household Media Tracker · phase 0</p>
    <h1>Device check</h1>
    <p class="lede">
      This page tests whether this phone can run the app as planned. It stores a few test rows and your two
      service keys on this device only.
    </p>
    <p class="score" aria-live="polite">
      <strong>{passed}</strong> of {checks.length} checks passed
      <span class="net" class:offline={!online}>{online ? 'Online' : 'No network'}</span>
    </p>
  </header>

  {#each GROUPS as group (group)}
    <section aria-labelledby={`group-${group}`}>
      <h2 id={`group-${group}`}>{group}</h2>

      {#if group === 'Services'}
        <form
          class="keys"
          onsubmit={(event) => {
            event.preventDefault();
            void runOnlineChecks();
          }}
        >
          <label>
            <span>TMDB key or token</span>
            <input type="password" bind:value={tmdbKey} autocomplete="off" autocapitalize="off" spellcheck="false" />
          </label>
          <label>
            <span>OMDb key</span>
            <input type="password" bind:value={omdbKey} autocomplete="off" autocapitalize="off" spellcheck="false" />
          </label>
          <label class="short">
            <span>Country code</span>
            <input type="text" bind:value={region} maxlength="2" autocapitalize="characters" spellcheck="false" />
          </label>
          <button type="submit" disabled={busy || !online}>
            {busy ? 'Running…' : online ? 'Run online checks' : 'Needs a network'}
          </button>
          <p class="hint">Keys are saved in this device's database and sent only to the service they belong to.</p>
        </form>
      {/if}

      <ul>
        {#each checks.filter((check) => check.group === group) as check (check.id)}
          <li class={check.status}>
            <span class="badge">{STATUS_WORD[check.status]}</span>
            <div>
              <p class="label">{check.label}</p>
              <p class="detail">{check.detail}</p>
              {#if check.id === 'persist' && check.status !== 'pass'}
                <button type="button" class="secondary" onclick={requestPersistence}>Ask the browser to protect storage</button>
              {/if}
              {#if check.id === 'poster' && posterSrc}
                <img class="poster" src={posterSrc} alt="Test poster shown from this device's cache" />
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  <section aria-labelledby="results">
    <h2 id="results">Results</h2>
    <div class="actions">
      <button type="button" onclick={copySummary}>{copied ? 'Copied' : 'Copy results'}</button>
      <button type="button" class="secondary" onclick={resetTestData}>
        {resetArmed ? 'Tap again to erase test data' : 'Reset test data'}
      </button>
    </div>
    {#if summaryOpen}
      <textarea readonly rows="12" aria-label="Results summary">{summary()}</textarea>
      <p class="hint">The summary contains statuses, counts and timings only. It holds no keys and no service content.</p>
    {/if}
  </section>

  <footer>
    <p>
      This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.
    </p>
    <p>
      Streaming availability data is provided by JustWatch. Episode data comes from
      <a href="https://www.tvmaze.com" rel="noreferrer">TVmaze</a>, licensed CC BY-SA 4.0. Review scores come from the
      OMDb API.
    </p>
  </footer>
</main>

<style>
  main {
    max-width: 40rem;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 4rem;
  }
  header {
    margin-bottom: 1.5rem;
  }
  .eyebrow {
    margin: 0 0 0.25rem;
    font-size: 0.8rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h1 {
    margin: 0 0 0.5rem;
    font-size: 1.9rem;
    line-height: 1.15;
  }
  .lede {
    margin: 0 0 1rem;
    color: var(--muted);
  }
  .score {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0;
  }
  .score strong {
    font-size: 1.4rem;
  }
  .net {
    margin-left: auto;
    padding: 0.15rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .net.offline {
    border-color: var(--warn);
    color: var(--warn);
  }
  section {
    margin-top: 1.75rem;
  }
  h2 {
    margin: 0 0 0.6rem;
    font-size: 0.85rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: 0.75rem;
    background: var(--panel);
  }
  li {
    display: grid;
    grid-template-columns: 4.25rem 1fr;
    gap: 0.75rem;
    padding: 0.85rem 1rem;
  }
  li + li {
    border-top: 1px solid var(--line);
  }
  .badge {
    align-self: start;
    padding: 0.15rem 0;
    border-radius: 0.4rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-align: center;
    color: var(--muted);
    border: 1px solid var(--line);
  }
  li.pass .badge {
    color: var(--good);
    border-color: var(--good);
  }
  li.fail .badge {
    color: var(--bad);
    border-color: var(--bad);
  }
  li.warn .badge {
    color: var(--warn);
    border-color: var(--warn);
  }
  .label {
    margin: 0;
    font-weight: 600;
  }
  .detail {
    margin: 0.15rem 0 0;
    font-size: 0.9rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .poster {
    display: block;
    width: 7rem;
    margin-top: 0.6rem;
    border-radius: 0.4rem;
  }
  .keys {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-bottom: 0.9rem;
  }
  .keys label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .keys label:not(.short) {
    grid-column: 1 / -1;
  }
  .keys button {
    align-self: end;
  }
  .hint {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  input,
  textarea {
    width: 100%;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    background: var(--panel);
    color: inherit;
    font: inherit;
  }
  textarea {
    margin: 0.75rem 0 0.4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.75rem;
  }
  button {
    min-height: 2.75rem;
    padding: 0.55rem 1rem;
    border: 1px solid var(--accent);
    border-radius: 0.5rem;
    background: var(--accent);
    color: var(--on-accent);
    font: inherit;
    font-weight: 600;
  }
  button.secondary {
    border-color: var(--line);
    background: transparent;
    color: inherit;
    font-weight: 500;
  }
  li button.secondary {
    margin-top: 0.6rem;
  }
  button:disabled {
    opacity: 0.55;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  footer {
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
    font-size: 0.8rem;
    color: var(--muted);
  }
  footer a {
    color: inherit;
  }
</style>
