<script lang="ts">
  import { onMount } from 'svelte';
  import { canShareFile, createBackupFile, downloadFile, recordBackup, restoreBackup, shareFile } from '../lib/backup';
  import { clearCache, getSetting } from '../lib/db';
  import { omdbRemainingToday } from '../lib/gateway/omdb';
  import { clearPosters } from '../lib/gateway/posters';
  import { lastRefreshAt, refreshAll } from '../lib/gateway/refresh';
  import { householdCounts, loadProfiles, saveProfileName } from '../lib/repo';
  import { nav } from '../lib/router.svelte';
  import { app, changed, loadConfig, saveConfig } from '../lib/state.svelte';

  let names = $state({ A: app.profiles.A, B: app.profiles.B });
  let keys = $state({ tmdbKey: app.tmdbKey, omdbKey: app.omdbKey, region: app.region });
  let message = $state({ profiles: '', keys: '', refresh: '', backup: '', restore: '', cache: '' });
  let counts = $state({ titles: 0, ratings: 0, unmatched: 0 });
  let lastBackup = $state<number | null>(null);
  let lastRefresh = $state<number | null>(null);
  let omdbLeft = $state<number | null>(null);
  let storage = $state('');
  let refreshing = $state(false);
  let backupFile = $state<File | null>(null);
  let restoreFile = $state<File | null>(null);
  let armed = $state('');

  const when = (at: number | null) =>
    at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';

  async function loadStatus() {
    counts = await householdCounts();
    const backupAt = await getSetting('last_backup_at');
    lastBackup = backupAt ? Number(backupAt) : null;
    lastRefresh = await lastRefreshAt();
    omdbLeft = await omdbRemainingToday();
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      storage = `${((estimate.usage ?? 0) / 1048576).toFixed(1)} MB used. ${
        persisted ? 'Protected from automatic clearing.' : 'Not yet protected from automatic clearing.'
      }`;
    }
  }

  onMount(() => {
    void loadStatus();
  });

  async function saveNames(event: SubmitEvent) {
    event.preventDefault();
    await saveProfileName('A', names.A);
    await saveProfileName('B', names.B);
    app.profiles = await loadProfiles();
    names = { ...app.profiles };
    message.profiles = 'Saved.';
    changed();
  }

  async function saveKeys(event: SubmitEvent) {
    event.preventDefault();
    const regionChanged = keys.region.trim().toUpperCase() !== app.region;
    await saveConfig(keys);
    keys = { tmdbKey: app.tmdbKey, omdbKey: app.omdbKey, region: app.region };
    message.keys = regionChanged ? 'Saved. Availability updates for the new country at the next refresh.' : 'Saved.';
  }

  async function refreshNow() {
    refreshing = true;
    message.refresh = '';
    try {
      const summary = await refreshAll((text) => (message.refresh = text));
      const parts = [
        `${summary.tmdb} title${summary.tmdb === 1 ? '' : 's'} updated`,
        `${summary.omdb} score${summary.omdb === 1 ? '' : 's'} updated`,
        `${summary.posters} poster${summary.posters === 1 ? '' : 's'} saved`,
      ];
      if (summary.failures) parts.push(`${summary.failures} could not be fetched and will be retried later`);
      message.refresh = summary.stoppedBecause ? `${summary.stoppedBecause} ${parts.join(', ')}.` : `${parts.join(', ')}.`;
    } catch (error) {
      message.refresh = error instanceof Error ? error.message : String(error);
    } finally {
      refreshing = false;
      await loadStatus();
    }
  }

  async function prepareBackup() {
    message.backup = 'Preparing…';
    try {
      backupFile = await createBackupFile();
      message.backup = '';
    } catch (error) {
      message.backup = error instanceof Error ? error.message : String(error);
    }
  }

  async function saveBackup(share: boolean) {
    if (!backupFile) return;
    try {
      if (share) {
        if (!(await shareFile(backupFile))) return;
      } else {
        downloadFile(backupFile);
      }
      await recordBackup();
      message.backup = `Backup made: ${backupFile.name}. Keep it somewhere other than this phone.`;
      backupFile = null;
      await loadStatus();
      changed();
    } catch (error) {
      message.backup = error instanceof Error ? error.message : String(error);
    }
  }

  async function restore() {
    if (!restoreFile) return;
    if (armed !== 'restore') {
      armed = 'restore';
      return;
    }
    armed = '';
    message.restore = 'Restoring…';
    try {
      const titles = await restoreBackup(restoreFile);
      app.profiles = await loadProfiles();
      names = { ...app.profiles };
      await loadConfig();
      restoreFile = null;
      message.restore = `Restored ${titles} title${titles === 1 ? '' : 's'}.`;
      changed();
      await loadStatus();
    } catch (error) {
      message.restore = error instanceof Error ? error.message : String(error);
    }
  }

  async function clearCachedData() {
    if (armed !== 'cache') {
      armed = 'cache';
      setTimeout(() => (armed = armed === 'cache' ? '' : armed), 4000);
      return;
    }
    armed = '';
    await clearCache();
    await clearPosters();
    message.cache = 'Cached data cleared. It is fetched again at the next refresh.';
    changed();
    await loadStatus();
  }
</script>

<h1>Settings</h1>

<section aria-labelledby="people">
  <h2 id="people">People</h2>
  <form class="panel form" onsubmit={saveNames}>
    <div class="pair">
      <label><span>First person</span><input bind:value={names.A} maxlength="24" required /></label>
      <label><span>Second person</span><input bind:value={names.B} maxlength="24" required /></label>
    </div>
    <div class="actions">
      <button type="submit">Save names</button>
      {#if message.profiles}<span class="muted small" role="status">{message.profiles}</span>{/if}
    </div>
  </form>
</section>

<section aria-labelledby="services">
  <h2 id="services">Data services</h2>
  <form class="panel form" onsubmit={saveKeys}>
    <label>
      <span>TMDB key or token</span>
      <input type="password" bind:value={keys.tmdbKey} autocomplete="off" autocapitalize="off" spellcheck="false" />
    </label>
    <label>
      <span>OMDb key</span>
      <input type="password" bind:value={keys.omdbKey} autocomplete="off" autocapitalize="off" spellcheck="false" />
    </label>
    <label class="short">
      <span>Country for streaming availability</span>
      <input bind:value={keys.region} maxlength="2" autocapitalize="characters" spellcheck="false" />
    </label>
    <p class="muted small">Keys stay on this device. Backups never include them.</p>
    <div class="actions">
      <button type="submit">Save</button>
      {#if message.keys}<span class="muted small" role="status">{message.keys}</span>{/if}
    </div>
  </form>

  <div class="panel form">
    <p class="small">
      Last refresh: {when(lastRefresh)}.
      {#if omdbLeft != null}OMDb lookups left today: {omdbLeft}.{/if}
    </p>
    <div class="actions">
      <button type="button" class="secondary" disabled={refreshing || !app.online} onclick={refreshNow}>
        {refreshing ? 'Refreshing…' : app.online ? 'Refresh now' : 'Needs a network'}
      </button>
      <button type="button" class="link" onclick={clearCachedData}>
        {armed === 'cache' ? 'Tap again to clear' : 'Clear cached data'}
      </button>
    </div>
    {#if message.refresh}<p class="small" role="status">{message.refresh}</p>{/if}
    {#if message.cache}<p class="small" role="status">{message.cache}</p>{/if}
  </div>
</section>

<section aria-labelledby="backup">
  <h2 id="backup">Backup</h2>
  <div class="panel form">
    <p class="small">
      {counts.titles} title{counts.titles === 1 ? '' : 's'} and {counts.ratings} rating{counts.ratings === 1 ? '' : 's'} on this
      device. Last backup: {when(lastBackup)}.
    </p>
    {#if backupFile}
      <div class="actions">
        <button type="button" onclick={() => saveBackup(false)}>Save the file</button>
        {#if canShareFile(backupFile)}
          <button type="button" class="secondary" onclick={() => saveBackup(true)}>Share…</button>
        {/if}
      </div>
    {:else}
      <button type="button" onclick={prepareBackup}>Make a backup</button>
    {/if}
    {#if message.backup}<p class="small" role="status">{message.backup}</p>{/if}
  </div>

  <div class="panel form">
    <label>
      <span>Restore from a backup file</span>
      <input
        type="file"
        onchange={(event) => {
          restoreFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
          armed = '';
          message.restore = '';
        }}
      />
    </label>
    {#if restoreFile}
      <button type="button" class={armed === 'restore' ? 'danger' : ''} onclick={restore}>
        {armed === 'restore' ? 'Tap again: this replaces everything on this device' : 'Restore'}
      </button>
    {/if}
    {#if message.restore}<p class="small" role="status">{message.restore}</p>{/if}
    <p class="muted small">Restoring keeps this device's keys and launch count.</p>
  </div>
</section>

<section aria-labelledby="device">
  <h2 id="device">This device</h2>
  <div class="panel form">
    {#if storage}<p class="small">{storage}</p>{/if}
    <p class="small"><a {...nav({ name: 'device-check' })}>Device check</a> · <a {...nav({ name: 'about' })}>About and data credits</a></p>
    <p class="muted small">Version {__APP_VERSION__}</p>
  </div>
</section>

<style>
  h1 {
    margin-bottom: 1rem;
  }
  section {
    margin-bottom: 1.5rem;
  }
  .form {
    display: grid;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    padding: 1rem;
  }
  .form p {
    margin: 0;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  label span {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .short input {
    max-width: 6rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }
</style>
