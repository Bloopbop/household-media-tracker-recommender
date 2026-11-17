<script lang="ts">
  import Poster from '../components/Poster.svelte';
  import RatingPicker from '../components/RatingPicker.svelte';
  import { formatRating, RATING_MAX, RATING_MIN } from '../lib/ratings';
  import { listLibrary, setRating } from '../lib/repo';
  import { back, go, nav } from '../lib/router.svelte';
  import { app, changed } from '../lib/state.svelte';
  import type { LibraryItem, ProfileId } from '../lib/types';

  let { person }: { person: ProfileId } = $props();

  let items = $state<LibraryItem[]>([]);
  let loaded = $state(false);
  /** Titles answered on this visit stay in view, so an answer can be undone. */
  let answered = $state<Record<string, { value: number; agreed: boolean }>>({});
  let picking = $state<string | null>(null);
  let draft = $state<number | null>(null);
  let error = $state('');

  $effect(() => {
    void app.version;
    void listLibrary().then((all) => {
      items = all.filter((item) => item.ratings.US != null);
      loaded = true;
    });
  });

  const reviewed = $derived(items.filter((item) => item.ratings[person] != null).length);
  const shown = $derived(
    items
      .filter((item) => item.ratings[person] == null || answered[item.id])
      .sort((a, b) => (b.ratings.US ?? 0) - (a.ratings.US ?? 0) || a.name.localeCompare(b.name)),
  );
  const other = $derived<ProfileId>(person === 'A' ? 'B' : 'A');

  async function save(item: LibraryItem, value: number | null, agreed: boolean) {
    error = '';
    try {
      await setRating(person, item.id, value, agreed ? 'agree' : 'adjust');
      if (value == null) {
        const { [item.id]: _removed, ...rest } = answered;
        answered = rest;
      } else {
        answered = { ...answered, [item.id]: { value, agreed } };
      }
      changed();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  function nudge(item: LibraryItem, step: number) {
    const start = answered[item.id]?.value ?? item.ratings.US ?? 5;
    const value = Math.min(RATING_MAX, Math.max(RATING_MIN, start + step));
    void save(item, value, value === item.ratings.US);
  }

  function openPicker(item: LibraryItem) {
    picking = item.id;
    draft = answered[item.id]?.value ?? item.ratings.US ?? null;
  }
</script>

<p class="back"><button type="button" class="link" onclick={() => back({ name: 'library' })}>← Back</button></p>
<h1>Shared ratings</h1>
<p class="muted lede">
  Your vault has one rating you agreed on for each title. Go through them one person at a time: agree, or nudge it to your own
  score. Where you differ is what the recommendations learn from.
</p>

<div class="who chips" role="group" aria-label="Whose turn">
  <button type="button" class="chip" aria-pressed={person === 'A'} onclick={() => go({ name: 'agree', person: 'A' }, { replace: true })}>
    {app.profiles.A}
  </button>
  <button type="button" class="chip" aria-pressed={person === 'B'} onclick={() => go({ name: 'agree', person: 'B' }, { replace: true })}>
    {app.profiles.B}
  </button>
</div>

{#if loaded}
  <p class="progress" aria-live="polite">
    <strong>{reviewed}</strong> of {items.length} reviewed by {app.profiles[person]}
  </p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if items.length === 0}
    <p class="muted">There are no agreed ratings yet. <a {...nav({ name: 'import' })}>Import your vault</a> first.</p>
  {:else if shown.length === 0}
    <p>All done for {app.profiles[person]}.</p>
    {#if items.some((item) => item.ratings[other] == null)}
      <button type="button" onclick={() => go({ name: 'agree', person: other }, { replace: true })}>Now {app.profiles[other]}</button>
    {/if}
  {/if}

  <ul class="list">
    {#each shown as item (item.id)}
      {@const answer = answered[item.id]}
      <li class:answered={answer}>
        <a class="thumb" {...nav({ name: 'title', id: item.id })} aria-label={`Open ${item.name}`}>
          <Poster path={item.posterPath} name={item.name} size="w92" />
        </a>
        <div class="body">
          <p class="name">{item.name}{item.year ? ` (${item.year})` : ''}</p>
          {#if picking === item.id}
            <RatingPicker label={`${app.profiles[person]}'s rating`} bind:value={draft} />
            <div class="buttons">
              <button
                type="button"
                disabled={draft == null}
                onclick={async () => {
                  await save(item, draft, draft === item.ratings.US);
                  picking = null;
                }}>Save</button
              >
              <button type="button" class="secondary" onclick={() => (picking = null)}>Cancel</button>
            </div>
          {:else if answer}
            <p class="result">
              {answer.agreed ? `Agreed: ${formatRating(answer.value)}` : `${app.profiles[person]}: ${formatRating(answer.value)}`}
              <span class="muted small">(shared {formatRating(item.ratings.US)})</span>
            </p>
            <div class="buttons">
              <button type="button" class="secondary small-button" aria-label="Half a point lower" onclick={() => nudge(item, -0.5)}>−½</button>
              <button type="button" class="secondary small-button" aria-label="Half a point higher" onclick={() => nudge(item, 0.5)}>+½</button>
              <button type="button" class="link" onclick={() => save(item, null, false)}>Undo</button>
            </div>
          {:else}
            <p class="shared">Shared rating <strong>{formatRating(item.ratings.US)}</strong></p>
            <div class="buttons">
              <button type="button" onclick={() => save(item, item.ratings.US ?? null, true)}>Agree</button>
              <button type="button" class="secondary small-button" aria-label="Half a point lower" onclick={() => nudge(item, -0.5)}>−½</button>
              <button type="button" class="secondary small-button" aria-label="Half a point higher" onclick={() => nudge(item, 0.5)}>+½</button>
              <button type="button" class="link" onclick={() => openPicker(item)}>Other</button>
            </div>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .back {
    margin: -0.5rem 0 0.25rem;
  }
  .lede {
    margin: 0.4rem 0 1rem;
  }
  .who {
    margin-bottom: 0.75rem;
  }
  .progress {
    margin: 0 0 0.75rem;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: grid;
    grid-template-columns: 3rem 1fr;
    gap: 0.75rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--line);
  }
  .list li.answered {
    opacity: 0.75;
  }
  .thumb {
    display: block;
  }
  .body {
    display: grid;
    gap: 0.4rem;
  }
  .body p {
    margin: 0;
  }
  .name {
    font-weight: 600;
  }
  .shared strong {
    font-size: 1.1rem;
  }
  .result {
    font-weight: 600;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .small-button {
    min-width: 2.75rem;
    padding: 0 0.6rem;
  }
  .error {
    color: var(--bad);
  }
</style>
