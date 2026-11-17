<script lang="ts">
  import { onMount } from 'svelte';
  import MarkWatched from '../components/MarkWatched.svelte';
  import Poster from '../components/Poster.svelte';
  import { exec } from '../lib/db';
  import { refreshTitle, saveTmdb } from '../lib/gateway/refresh';
  import { fetchDetails, searchTitles } from '../lib/gateway/tmdb';
  import { addTitle, linkTitle, markTmdbChecked, markWatched, setStatusFor, tmdbCacheKey, type WatchInput } from '../lib/repo';
  import { back, go, nav } from '../lib/router.svelte';
  import { app, changed } from '../lib/state.svelte';
  import { KIND_LABEL, type Kind, type SearchResult, type Who } from '../lib/types';

  let { query = '', link }: { query?: string; link?: string } = $props();

  let text = $state('');
  let results = $state<SearchResult[]>([]);
  let searching = $state(false);
  let error = $state('');
  let inLibrary = $state(new Map<string, string>());
  let chosen = $state<SearchResult | null>(null);
  let mode = $state<'choose' | 'watched' | 'watchlist'>('choose');
  let watchlistWho = $state<Who>('both');
  let busy = $state(false);
  let manual = $state({ open: false, name: '', year: '', kind: 'movie' as Kind });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let input: HTMLInputElement | undefined = $state();

  const canSearch = $derived(app.online && app.tmdbKey !== '');

  onMount(() => {
    // The address's query fills the search box once, when the screen opens.
    text = query;
    manual.name = query;
    void loadLibraryIds();
    if (text) void search();
    input?.focus();
    return () => clearTimeout(timer);
  });

  async function loadLibraryIds() {
    const rows = await exec<{ id: string; kind: Kind; tmdb_id: number }>('SELECT id, kind, tmdb_id FROM title WHERE tmdb_id IS NOT NULL');
    inLibrary = new Map(rows.map((row) => [tmdbCacheKey(row.kind, row.tmdb_id), row.id]));
  }

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(search, 350);
  }

  async function search() {
    const current = text.trim();
    chosen = null;
    if (!current || !canSearch) {
      results = [];
      return;
    }
    searching = true;
    error = '';
    try {
      const found = await searchTitles(app.tmdbKey, current);
      if (text.trim() === current) results = found.slice(0, 20);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      searching = false;
    }
  }

  /** Creates (or finds) the title and caches its details, then returns its id. */
  async function ensureTitle(result: SearchResult): Promise<string> {
    const existing = inLibrary.get(tmdbCacheKey(result.kind, result.tmdbId));
    if (existing) return existing;
    const id = await addTitle({ kind: result.kind, name: result.name, year: result.year, tmdbId: result.tmdbId, source: 'search' });
    try {
      // Fetch details now so the poster and IMDb id are there straight away.
      const details = await fetchDetails(app.tmdbKey, result.kind, result.tmdbId, app.region);
      await saveTmdb(details, app.region);
      await markTmdbChecked(id, details.imdbId);
      void refreshTitle(id).catch(() => {});
    } catch {
      // The daily refresh will try again.
    }
    return id;
  }

  async function pick(result: SearchResult) {
    const existing = inLibrary.get(tmdbCacheKey(result.kind, result.tmdbId));
    if (link) {
      busy = true;
      try {
        const id = await linkTitle(link, result.kind, result.tmdbId, result.name, result.year);
        await refreshTitle(id, { force: true }).catch(() => {});
        changed();
        go({ name: 'title', id }, { replace: true });
      } finally {
        busy = false;
      }
      return;
    }
    if (existing) {
      go({ name: 'title', id: existing });
      return;
    }
    chosen = result;
    mode = 'choose';
  }

  async function saveWatched(input: Omit<WatchInput, 'titleId'> & { titleId: string }) {
    if (!chosen) return;
    const id = await ensureTitle(chosen);
    await markWatched({ ...input, titleId: id });
    changed();
    go({ name: 'title', id }, { replace: true });
  }

  async function saveWatchlist() {
    if (!chosen) return;
    busy = true;
    try {
      const id = await ensureTitle(chosen);
      await setStatusFor(watchlistWho, id, 'watchlist');
      changed();
      go({ name: 'title', id }, { replace: true });
    } finally {
      busy = false;
    }
  }

  async function addManually(event: SubmitEvent) {
    event.preventDefault();
    const name = manual.name.trim();
    if (!name) return;
    const year = /^\d{4}$/.test(manual.year.trim()) ? Number(manual.year.trim()) : null;
    const id = await addTitle({ kind: manual.kind, name, year, source: 'stub' });
    changed();
    go({ name: 'title', id }, { replace: true });
  }
</script>

<p class="back"><button type="button" class="link" onclick={() => back({ name: 'library' })}>← Back</button></p>
<h1>{link ? 'Find the right title' : 'Add a title'}</h1>
{#if link}
  <p class="muted small">Pick the matching entry. Everything already recorded for this title is kept.</p>
{/if}

{#if canSearch}
  <label class="search">
    <span class="visually-hidden">Search movies and series</span>
    <input
      bind:this={input}
      type="search"
      placeholder="Search movies and series"
      bind:value={text}
      oninput={onInput}
      autocomplete="off"
      enterkeyhint="search"
    />
  </label>
{:else}
  <p class="notice">
    {app.online ? 'Searching needs a TMDB key.' : 'Searching needs a network connection.'}
    {#if !app.tmdbKey}<a {...nav({ name: 'settings' })}>Add a key in Settings</a>.{/if}
    {#if !link}You can still add a title by name and find it later.{/if}
  </p>
{/if}

{#if searching}<p class="muted small" aria-live="polite">Searching…</p>{/if}
{#if error}<p class="warn small" role="alert">{error}</p>{/if}

{#if chosen}
  <div class="panel chosen">
    <div class="chosen-head">
      <div class="thumb"><Poster path={chosen.posterPath} name={chosen.name} size="w185" /></div>
      <div>
        <p class="name">{chosen.name}</p>
        <p class="muted small">{KIND_LABEL[chosen.kind]}{chosen.year ? ` · ${chosen.year}` : ''}</p>
      </div>
    </div>
    {#if mode === 'choose'}
      <div class="actions">
        <button type="button" onclick={() => (mode = 'watched')}>Watched it</button>
        <button type="button" class="secondary" onclick={() => (mode = 'watchlist')}>Want to watch</button>
        <button type="button" class="link" onclick={() => (chosen = null)}>Back to results</button>
      </div>
    {:else if mode === 'watched'}
      <MarkWatched titleId="" kind={chosen.kind} onsave={saveWatched} oncancel={() => (mode = 'choose')} />
    {:else}
      <fieldset>
        <legend class="muted small">Who wants to watch it</legend>
        <div class="chips">
          <label class="chip"><input type="radio" bind:group={watchlistWho} value="both" />Both</label>
          <label class="chip"><input type="radio" bind:group={watchlistWho} value="A" />{app.profiles.A}</label>
          <label class="chip"><input type="radio" bind:group={watchlistWho} value="B" />{app.profiles.B}</label>
        </div>
      </fieldset>
      <div class="actions">
        <button type="button" disabled={busy} onclick={saveWatchlist}>Add to watchlist</button>
        <button type="button" class="secondary" onclick={() => (mode = 'choose')}>Cancel</button>
      </div>
    {/if}
  </div>
{:else if results.length > 0}
  <ul class="results">
    {#each results as result (`${result.kind}:${result.tmdbId}`)}
      {@const existing = inLibrary.has(tmdbCacheKey(result.kind, result.tmdbId))}
      <li>
        <button type="button" class="result" disabled={busy} onclick={() => pick(result)}>
          <span class="thumb"><Poster path={result.posterPath} name={result.name} size="w92" /></span>
          <span class="text">
            <span class="name">{result.name}</span>
            <span class="muted small">
              {KIND_LABEL[result.kind]}{result.year ? ` · ${result.year}` : ''}{existing ? ' · in your library' : ''}
            </span>
          </span>
        </button>
      </li>
    {/each}
  </ul>
  <p class="credit">Search results from TMDB.</p>
{:else if text.trim() && canSearch && !searching && !error}
  <p class="muted">No matches. Try fewer words, or the original title.</p>
{/if}

{#if !link && !chosen}
  {#if manual.open || !canSearch}
    <form class="panel manual" onsubmit={addManually}>
      <h2>Add by name</h2>
      <label><span class="muted small">Title</span><input bind:value={manual.name} required /></label>
      <div class="pair">
        <label><span class="muted small">Year</span><input bind:value={manual.year} inputmode="numeric" maxlength="4" /></label>
        <label>
          <span class="muted small">Type</span>
          <select bind:value={manual.kind}>
            <option value="movie">Movie</option>
            <option value="series">Series</option>
          </select>
        </label>
      </div>
      <button type="submit">Add</button>
      <p class="muted small">It shows under “Not matched yet” until you find it in a search.</p>
    </form>
  {:else}
    <button type="button" class="link" onclick={() => (manual = { ...manual, open: true, name: text })}>Can't find it? Add it by name</button>
  {/if}
{/if}

<style>
  .back {
    margin: -0.5rem 0 0.25rem;
  }
  h1 {
    margin-bottom: 0.75rem;
  }
  .search {
    display: block;
    margin-bottom: 0.75rem;
  }
  .results {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .result {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.4rem 0;
    border: none;
    border-bottom: 1px solid var(--line);
    border-radius: 0;
    background: none;
    color: inherit;
    font-weight: 400;
    text-align: left;
    justify-content: flex-start;
  }
  .thumb {
    display: block;
    flex: 0 0 2.75rem;
    width: 2.75rem;
  }
  .text {
    display: grid;
  }
  .name {
    margin: 0;
    font-weight: 600;
  }
  .chosen {
    display: grid;
    gap: 1rem;
    padding: 1rem;
  }
  .chosen-head {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .chosen-head .thumb {
    flex-basis: 4rem;
    width: 4rem;
  }
  .chosen-head p {
    margin: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: none;
  }
  .manual {
    display: grid;
    gap: 0.75rem;
    margin-top: 1.25rem;
    padding: 1rem;
  }
  .manual label {
    display: grid;
    gap: 0.25rem;
  }
  .manual p {
    margin: 0;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .notice {
    padding: 0.75rem 1rem;
    border-left: 3px solid var(--warn);
    background: var(--panel);
    font-size: 0.9rem;
  }
  .warn {
    color: var(--warn);
  }
  .credit {
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
