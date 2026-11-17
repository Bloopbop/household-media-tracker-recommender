<script lang="ts">
  import { localToday } from '../lib/library';
  import type { WatchInput, WatchOutcome } from '../lib/repo';
  import { app } from '../lib/state.svelte';
  import type { Kind, Rater, Who } from '../lib/types';
  import RatingPicker from './RatingPicker.svelte';

  let {
    titleId,
    kind,
    onsave,
    oncancel,
  }: {
    titleId: string;
    kind: Kind;
    onsave: (input: WatchInput) => Promise<void>;
    oncancel?: () => void;
  } = $props();

  let who = $state<Who>('both');
  let outcome = $state<WatchOutcome>('finished');
  let date = $state(localToday());
  let dateUnknown = $state(false);
  let separately = $state(false);
  let agreed = $state<number | null>(null);
  let ratingA = $state<number | null>(null);
  let ratingB = $state<number | null>(null);
  let saving = $state(false);
  let error = $state('');

  const outcomes = $derived<{ value: WatchOutcome; label: string }[]>(
    kind === 'series'
      ? [
          { value: 'finished', label: 'Finished it' },
          { value: 'watching', label: 'Still watching' },
          { value: 'stopped', label: 'Gave up' },
        ]
      : [
          { value: 'finished', label: 'Finished' },
          { value: 'stopped', label: 'Stopped partway' },
        ],
  );

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const ratings: Partial<Record<Rater, number>> = {};
    if (who === 'both' && !separately && agreed != null) ratings.US = agreed;
    if ((who === 'A' || (who === 'both' && separately)) && ratingA != null) ratings.A = ratingA;
    if ((who === 'B' || (who === 'both' && separately)) && ratingB != null) ratings.B = ratingB;
    saving = true;
    error = '';
    try {
      await onsave({ titleId, who, outcome, watchedOn: dateUnknown || !date ? null : date, ratings });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      saving = false;
    }
  }
</script>

<form class="watched" onsubmit={save}>
  <fieldset>
    <legend>Who watched</legend>
    <div class="chips">
      <label class="chip"><input type="radio" bind:group={who} value="both" />Both</label>
      <label class="chip"><input type="radio" bind:group={who} value="A" />{app.profiles.A}</label>
      <label class="chip"><input type="radio" bind:group={who} value="B" />{app.profiles.B}</label>
    </div>
  </fieldset>

  <fieldset>
    <legend>How far</legend>
    <div class="chips">
      {#each outcomes as option (option.value)}
        <label class="chip"><input type="radio" bind:group={outcome} value={option.value} />{option.label}</label>
      {/each}
    </div>
  </fieldset>

  <div class="date">
    <label>
      <span class="muted small">When</span>
      <input type="date" bind:value={date} disabled={dateUnknown} max={localToday()} />
    </label>
    <label class="check"><input type="checkbox" bind:checked={dateUnknown} /> Not sure when</label>
  </div>

  {#if who === 'both' && !separately}
    <RatingPicker label="Your agreed rating" bind:value={agreed} />
    <button type="button" class="link" onclick={() => (separately = true)}>Rate separately instead</button>
  {:else}
    {#if who !== 'B'}
      <RatingPicker label={`${app.profiles.A}'s rating`} bind:value={ratingA} />
    {/if}
    {#if who !== 'A'}
      <RatingPicker label={`${app.profiles.B}'s rating`} bind:value={ratingB} />
    {/if}
    {#if who === 'both'}
      <button type="button" class="link" onclick={() => (separately = false)}>Give one agreed rating instead</button>
    {/if}
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <div class="actions">
    <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    {#if oncancel}<button type="button" class="secondary" onclick={oncancel}>Cancel</button>{/if}
  </div>
</form>

<style>
  .watched {
    display: grid;
    gap: 1rem;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: none;
  }
  legend {
    margin-bottom: 0.4rem;
    font-size: 0.9rem;
    color: var(--muted);
  }
  .date {
    display: grid;
    gap: 0.4rem;
  }
  .date label {
    display: grid;
    gap: 0.25rem;
  }
  .check {
    display: flex !important;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
  }
  .check input {
    width: 1.25rem;
    min-height: 1.25rem;
    height: 1.25rem;
  }
  .actions {
    display: flex;
    gap: 0.75rem;
  }
  .error {
    margin: 0;
    color: var(--bad);
  }
</style>
