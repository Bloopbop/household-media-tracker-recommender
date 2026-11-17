<script lang="ts">
  import Poster from '../components/Poster.svelte';
  import { getSetting } from '../lib/db';
  import { DEFAULT_FILTERS, filterLibrary, genresIn, shownRating, type LibraryFilters } from '../lib/library';
  import { formatRating } from '../lib/ratings';
  import { listLibrary } from '../lib/repo';
  import { nav } from '../lib/router.svelte';
  import { app } from '../lib/state.svelte';
  import { STATUSES, STATUS_LABEL, type LibraryItem } from '../lib/types';

  // Filters survive moving between screens, but not a restart.
  const saved = sessionStorage.getItem('library-filters');
  let filters = $state<LibraryFilters>(saved ? { ...DEFAULT_FILTERS, ...JSON.parse(saved) } : { ...DEFAULT_FILTERS });
  let items = $state<LibraryItem[]>([]);
  let loaded = $state(false);
  let backupDue = $state(false);

  $effect(() => {
    void app.version;
    void load();
  });

  $effect(() => {
    sessionStorage.setItem('library-filters', JSON.stringify(filters));
  });

  async function load() {
    items = await listLibrary();
    loaded = true;
    const last = Number((await getSetting('last_backup_at')) ?? 0);
    backupDue = items.length > 0 && Date.now() - last > 30 * 86_400_000;
  }

  const shown = $derived(filterLibrary([...items], filters));
  const genres = $derived(genresIn(items));
  const unmatched = $derived(items.filter((item) => item.tmdbId == null));
  const activeFilters = $derived(
    [filters.person !== 'any', filters.status !== 'any', filters.kind !== 'any', filters.genre !== ''].filter(Boolean).length,
  );
  // Open when a filter is already set, so a narrowed list is never a surprise.
  let showFilters = $state(false);
  $effect.pre(() => {
    if (activeFilters > 0) showFilters = true;
  });
  const filtered = $derived(
    filters.query !== '' || filters.person !== 'any' || filters.status !== 'any' || filters.kind !== 'any' || filters.genre !== '',
  );
</script>

<header class="top">
  <div>
    <h1>Library</h1>
    {#if loaded}
      <p class="muted small count">
        {filtered ? `${shown.length} of ${items.length}` : items.length} title{items.length === 1 ? '' : 's'}
      </p>
    {/if}
  </div>
  <a class="button" {...nav({ name: 'add', query: '' })}>Add</a>
</header>

{#if app.refreshStatus}
  <p class="muted small status" aria-live="polite">{app.refreshStatus}</p>
{/if}

{#if backupDue}
  <p class="notice">
    No backup in the last 30 days. <a {...nav({ name: 'settings' })}>Save one in Settings</a>.
  </p>
{/if}

{#if unmatched.length > 0}
  <section class="notice" aria-labelledby="unmatched">
    <h2 id="unmatched">Not matched yet</h2>
    <p class="small muted">These were added without a search. Find each one so its details and poster can load.</p>
    <ul class="unmatched">
      {#each unmatched as item (item.id)}
        <li>
          <span>{item.name}{item.year ? ` (${item.year})` : ''}</span>
          <a class="button secondary" {...nav({ name: 'add', query: item.name, link: item.id })}>Find it</a>
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if items.length > 0}
  <div class="toolbar">
    <label class="search">
      <span class="visually-hidden">Search titles and notes</span>
      <input type="search" placeholder="Search titles and notes" bind:value={filters.query} autocomplete="off" />
    </label>
    <button type="button" class="secondary" aria-expanded={showFilters} aria-controls="library-filters" onclick={() => (showFilters = !showFilters)}>
      Filters{activeFilters ? ` (${activeFilters})` : ''}
    </button>
  </div>
  {#if showFilters}
  <div class="filters" id="library-filters">
    <label>
      <span class="visually-hidden">Whose</span>
      <select bind:value={filters.person}>
        <option value="any">Everyone</option>
        <option value="both">Both of us</option>
        <option value="A">{app.profiles.A}</option>
        <option value="B">{app.profiles.B}</option>
      </select>
    </label>
    <label>
      <span class="visually-hidden">Status</span>
      <select bind:value={filters.status}>
        <option value="any">Any status</option>
        {#each STATUSES as status (status)}
          <option value={status}>{STATUS_LABEL[status]}</option>
        {/each}
      </select>
    </label>
    <label>
      <span class="visually-hidden">Type</span>
      <select bind:value={filters.kind}>
        <option value="any">Movies and series</option>
        <option value="movie">Movies</option>
        <option value="series">Series</option>
      </select>
    </label>
    <label>
      <span class="visually-hidden">Genre</span>
      <select bind:value={filters.genre}>
        <option value="">Any genre</option>
        {#each genres as genre (genre)}
          <option value={genre}>{genre}</option>
        {/each}
      </select>
    </label>
    <label>
      <span class="visually-hidden">Sort by</span>
      <select bind:value={filters.sort}>
        <option value="added">Recently added</option>
        <option value="rating">Highest rated</option>
        <option value="name">Title</option>
        <option value="year">Newest</option>
      </select>
    </label>
    {#if activeFilters}
      <button type="button" class="link" onclick={() => (filters = { ...DEFAULT_FILTERS, query: filters.query, sort: filters.sort })}>Clear filters</button>
    {/if}
  </div>
  {/if}

  <ul class="grid">
    {#each shown as item (item.id)}
      {@const rating = shownRating(item, filters.person)}
      <li>
        <a class="card" {...nav({ name: 'title', id: item.id })}>
          <Poster path={item.posterPath} name={item.name} />
          <span class="name">{item.name}</span>
          <span class="meta muted">
            {item.year ?? ''}{#if rating != null}<span class="rating"> · {formatRating(rating)}</span>{/if}
          </span>
        </a>
      </li>
    {/each}
  </ul>
  {#if shown.length === 0}
    <p class="muted empty">Nothing matches these filters.</p>
  {/if}
{:else if loaded}
  <div class="empty">
    <p>Nothing here yet.</p>
    <p class="muted small">Add something you have watched, or something you want to watch. Importing your vault comes in the next update.</p>
    <a class="button" {...nav({ name: 'add', query: '' })}>Add a title</a>
  </div>
{/if}

<style>
  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .count {
    margin: 0.15rem 0 0;
  }
  .status {
    margin: -0.5rem 0 1rem;
  }
  .notice {
    margin: 0 0 1rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--line);
    border-left: 3px solid var(--warn);
    border-radius: 0.5rem;
    background: var(--panel);
    font-size: 0.9rem;
  }
  .notice h2 {
    margin-bottom: 0.25rem;
  }
  .notice p {
    margin: 0 0 0.5rem;
  }
  .unmatched {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .unmatched li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.25rem 0;
  }
  .toolbar {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .toolbar .search {
    flex: 1;
  }
  .filters {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .filters select {
    font-size: 0.9rem;
  }
  .filters .link {
    justify-self: start;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
    gap: 1rem 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: grid;
    gap: 0.3rem;
    text-decoration: none;
  }
  .name {
    overflow: hidden;
    font-size: 0.85rem;
    font-weight: 600;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .meta {
    margin-top: -0.2rem;
    font-size: 0.8rem;
  }
  .rating {
    color: var(--text);
    font-weight: 600;
  }
  .empty {
    padding: 2rem 0;
    text-align: center;
  }
  .empty p {
    margin: 0 0 0.75rem;
  }
  @media (min-width: 40rem) {
    .filters {
      grid-template-columns: repeat(5, 1fr);
      align-items: center;
    }
  }
</style>
