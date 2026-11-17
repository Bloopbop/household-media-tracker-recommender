<script lang="ts">
  import Poster from '../components/Poster.svelte';
  import { listLibrary } from '../lib/repo';
  import { nav } from '../lib/router.svelte';
  import { app } from '../lib/state.svelte';
  import type { LibraryItem } from '../lib/types';

  let items = $state<LibraryItem[]>([]);

  $effect(() => {
    void app.version;
    void listLibrary().then((all) => (items = all.filter((item) => item.status.A === 'watchlist' || item.status.B === 'watchlist')));
  });

  const groups = $derived([
    { label: 'Both of you', items: items.filter((item) => item.status.A === 'watchlist' && item.status.B === 'watchlist') },
    { label: app.profiles.A, items: items.filter((item) => item.status.A === 'watchlist' && item.status.B !== 'watchlist') },
    { label: app.profiles.B, items: items.filter((item) => item.status.B === 'watchlist' && item.status.A !== 'watchlist') },
  ]);
</script>

<h1>For you</h1>
<p class="muted lede">Recommendations arrive in the next phase. Until then, here is what is on your watchlists.</p>

{#each groups as group (group.label)}
  {#if group.items.length > 0}
    <section>
      <h2>{group.label}</h2>
      <ul class="row">
        {#each group.items as item (item.id)}
          <li>
            <a {...nav({ name: 'title', id: item.id })}>
              <Poster path={item.posterPath} name={item.name} />
              <span class="name">{item.name}</span>
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/each}

{#if items.length === 0}
  <p class="muted">Nothing on a watchlist yet. Use “Want to watch” when you add a title.</p>
{/if}

<style>
  .lede {
    margin: 0.4rem 0 1.25rem;
  }
  section {
    margin-bottom: 1.5rem;
  }
  .row {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 7rem;
    gap: 0.75rem;
    margin: 0;
    padding: 0 0 0.5rem;
    overflow-x: auto;
    list-style: none;
    scroll-snap-type: x mandatory;
  }
  .row li {
    scroll-snap-align: start;
  }
  .row a {
    display: grid;
    gap: 0.3rem;
    text-decoration: none;
  }
  .name {
    font-size: 0.85rem;
    font-weight: 600;
    line-height: 1.25;
  }
</style>
