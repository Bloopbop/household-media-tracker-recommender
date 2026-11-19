<script lang="ts">
  import { onMount } from 'svelte';
  import Poster from '../components/Poster.svelte';
  import { refreshSlates, runRecJob } from '../lib/rec/job';
  import { getLastMode, loadSlate, setLastMode, type StoredSlate } from '../lib/rec/store';
  import { MODES, type Mode } from '../lib/rec/types';
  import { nav } from '../lib/router.svelte';
  import { app } from '../lib/state.svelte';
  import { KIND_LABEL } from '../lib/types';

  let mode = $state<Mode | null>(null);
  let slate = $state<StoredSlate | null>(null);
  let loaded = $state(false);

  onMount(() => {
    void getLastMode().then((last) => (mode = last));
    // Rebuild in the background if ratings or candidates changed since the last slate.
    void refreshSlates();
  });

  $effect(() => {
    void app.slatesVersion;
    const current = mode;
    if (!current) return;
    void loadSlate(current).then((result) => {
      if (mode !== current) return;
      slate = result;
      loaded = true;
      if (result?.picks.length && app.slateShownMs == null) app.slateShownMs = Math.round(performance.now());
    });
  });

  async function choose(next: Mode) {
    mode = next;
    await setLastMode(next);
  }

  const label = (value: Mode) => (value === 'US' ? 'Together' : app.profiles[value]);
  const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<h1>For you</h1>

<div class="modes" role="group" aria-label="Whose picks">
  {#each MODES as value (value)}
    <button type="button" class="mode" aria-pressed={mode === value} onclick={() => choose(value)}>{label(value)}</button>
  {/each}
</div>

{#if app.recStatus}<p class="status small muted" aria-live="polite">{app.recStatus}</p>{/if}
{#if app.recError && !app.recStatus}<p class="status small warn" role="status">{app.recError}</p>{/if}

{#if slate?.stats.coldProfile}
  <p class="notice">Learning your taste: rate more titles in the Library and these picks will sharpen.</p>
{/if}

{#if slate && slate.picks.length > 0 && mode}
  <ol class="slate">
    {#each slate.picks as pick (pick.key)}
      <li>
        <a class="pick" {...nav({ name: 'pick', key: pick.key, mode })}>
          <span class="thumb"><Poster path={pick.posterPath} name={pick.name} /></span>
          <span class="text">
            <span class="name">{pick.name}</span>
            <span class="meta">{KIND_LABEL[pick.kind]}{pick.year ? ` · ${pick.year}` : ''} · {pick.evidence.availability.label}</span>
            <span class="reason">{pick.reason}</span>
            {#if pick.exploratory || pick.rewatch}
              <span class="tags">
                {#if pick.exploratory}<span class="tag">Exploratory</span>{/if}
                {#if pick.rewatch}<span class="tag">Rewatch</span>{/if}
              </span>
            {/if}
          </span>
        </a>
      </li>
    {/each}
  </ol>
  <p class="small muted footer">
    Picked from {slate.stats.candidates.toLocaleString()} candidates · updated {when(slate.createdAt)}
  </p>
{:else if loaded}
  <div class="panel empty">
    {#if !app.tmdbKey}
      <p>Recommendations need a TMDB key. <a {...nav({ name: 'settings' })}>Add one in Settings</a>.</p>
    {:else if app.recStatus}
      <p>Your first picks appear here as the candidates come in. Keep the app open; this takes about ten minutes the first time.</p>
    {:else if !app.online}
      <p>Recommendations need one session with a network connection to find candidates.</p>
    {:else}
      <p>No picks yet.</p>
      <button type="button" onclick={() => runRecJob()}>Look for picks now</button>
    {/if}
  </div>
{/if}

<style>
  .modes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
    margin: 0.75rem 0 1rem;
  }
  .mode {
    min-height: 2.75rem;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--text);
    font-weight: 600;
  }
  .mode[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--on-accent);
  }
  .status {
    margin: 0 0 0.75rem;
  }
  .warn {
    color: var(--warn);
  }
  .notice {
    margin: 0 0 1rem;
    padding: 0.75rem 1rem;
    border-left: 3px solid var(--warn);
    background: var(--panel);
    font-size: 0.9rem;
  }
  .slate {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pick {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    gap: 0.85rem;
    color: inherit;
    text-decoration: none;
  }
  .text {
    display: grid;
    align-content: start;
    gap: 0.25rem;
    min-width: 0;
  }
  .name {
    font-weight: 700;
    line-height: 1.25;
  }
  .meta {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .reason {
    font-size: 0.9rem;
    line-height: 1.35;
  }
  .tags {
    display: flex;
    gap: 0.4rem;
  }
  .tag {
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted);
  }
  .footer {
    margin-top: 1.25rem;
  }
  .empty {
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
  }
  .empty p {
    margin: 0;
  }
</style>
