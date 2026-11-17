<script lang="ts">
  import { onMount } from 'svelte';
  import { exec, openDb } from './lib/db';
  import { isStandalone } from './lib/checks';
  import { refreshIfDue } from './lib/gateway/refresh';
  import { checkNetwork } from './lib/network';
  import { loadProfiles } from './lib/repo';
  import { nav, router } from './lib/router.svelte';
  import { app, loadConfig } from './lib/state.svelte';
  import About from './views/About.svelte';
  import AddTitle from './views/AddTitle.svelte';
  import DeviceCheck from './views/DeviceCheck.svelte';
  import Library from './views/Library.svelte';
  import Recommend from './views/Recommend.svelte';
  import Settings from './views/Settings.svelte';
  import TitleDetail from './views/TitleDetail.svelte';

  const tab = $derived.by(() => {
    const name = router.route.name;
    if (name === 'recommend') return 'recommend';
    if (name === 'settings' || name === 'device-check' || name === 'about') return 'settings';
    return 'library';
  });

  async function start() {
    try {
      const info = await openDb();
      if (info.storage !== 'opfs') {
        app.error = `This device's storage could not be opened, so nothing will be saved. ${info.storageError}`;
      }
      app.online = await checkNetwork();
      // Counts every start of the app on this device (the phase 0 launch number).
      await exec('INSERT INTO spike_boot (at, online, standalone) VALUES (?, ?, ?)', [
        new Date().toISOString(),
        app.online ? 1 : 0,
        isStandalone() ? 1 : 0,
      ]);
      app.profiles = await loadProfiles();
      await loadConfig();
      app.ready = true;
    } catch (error) {
      app.error = error instanceof Error ? error.message : String(error);
      return;
    }
    void refreshIfDue((text) => (app.refreshStatus = text)).catch(() => (app.refreshStatus = ''));
  }

  onMount(() => {
    const update = async () => (app.online = await checkNetwork());
    addEventListener('online', update);
    addEventListener('offline', update);
    void start();
    return () => {
      removeEventListener('online', update);
      removeEventListener('offline', update);
    };
  });
</script>

{#if app.error}
  <p class="banner error" role="alert">{app.error}</p>
{/if}

{#if app.ready}
  <div class="screen">
    {#if router.route.name === 'library'}
      <Library />
    {:else if router.route.name === 'recommend'}
      <Recommend />
    {:else if router.route.name === 'title'}
      {#key router.route.id}
        <TitleDetail id={router.route.id} />
      {/key}
    {:else if router.route.name === 'add'}
      {#key `${router.route.query}|${router.route.link ?? ''}`}
        <AddTitle query={router.route.query} link={router.route.link} />
      {/key}
    {:else if router.route.name === 'settings'}
      <Settings />
    {:else if router.route.name === 'device-check'}
      <DeviceCheck />
    {:else if router.route.name === 'about'}
      <About />
    {/if}
  </div>

  <nav class="tabs" aria-label="Main">
    <a {...nav({ name: 'recommend' })} aria-current={tab === 'recommend' ? 'page' : undefined}>For you</a>
    <a {...nav({ name: 'library' })} aria-current={tab === 'library' ? 'page' : undefined}>Library</a>
    <a {...nav({ name: 'settings' })} aria-current={tab === 'settings' ? 'page' : undefined}>Settings</a>
  </nav>
{:else if !app.error}
  <p class="loading">Opening…</p>
{/if}

<style>
  .screen {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1rem 1rem calc(5rem + env(safe-area-inset-bottom));
  }
  .tabs {
    position: fixed;
    inset: auto 0 0 0;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    padding-bottom: env(safe-area-inset-bottom);
    border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    z-index: 10;
  }
  .tabs a {
    display: grid;
    place-items: center;
    min-height: 3.25rem;
    color: var(--muted);
    font-size: 0.9rem;
    font-weight: 600;
    text-decoration: none;
  }
  .tabs a[aria-current='page'] {
    color: var(--text);
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .banner {
    margin: 0;
    padding: 0.75rem 1rem;
    font-size: 0.9rem;
  }
  .banner.error {
    background: var(--bad);
    color: #fff;
  }
  .loading {
    padding: 3rem 1rem;
    text-align: center;
    color: var(--muted);
  }
</style>
