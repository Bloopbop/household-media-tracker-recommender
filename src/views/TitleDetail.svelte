<script lang="ts">
  import { onMount } from 'svelte';
  import MarkWatched from '../components/MarkWatched.svelte';
  import Poster from '../components/Poster.svelte';
  import RatingPicker from '../components/RatingPicker.svelte';
  import { DAY_MS, isStale, omdbMaxAgeDays, tmdbMaxAgeDays } from '../lib/gateway/policy';
  import { refreshTitle } from '../lib/gateway/refresh';
  import { logoUrl } from '../lib/gateway/tmdb';
  import { yearSpan } from '../lib/library';
  import { effectiveRating, formatRating, whoFromParticipants } from '../lib/ratings';
  import {
    deleteWatchEvent,
    getTitle,
    markWatched,
    removeTitle,
    saveNote,
    setRating,
    setStatus,
    setWouldRewatch,
    type WatchInput,
  } from '../lib/repo';
  import { back, go, nav } from '../lib/router.svelte';
  import { app, changed, personName } from '../lib/state.svelte';
  import {
    KIND_LABEL,
    PROFILE_IDS,
    STATUSES,
    STATUS_LABEL,
    type Provider,
    type Rater,
    type Status,
    type TitleDetail,
  } from '../lib/types';

  let { id }: { id: string } = $props();

  let detail = $state<TitleDetail | undefined>();
  let loaded = $state(false);
  let updating = $state(false);
  let updateError = $state('');
  let editing = $state<Rater | null>(null);
  let draft = $state<number | null>(null);
  let logging = $state(false);
  let armed = $state('');
  let noteDraft = $state({ id: '', author: 'US' as Rater, text: '', open: false });

  $effect(() => {
    void app.version;
    void load();
  });

  async function load() {
    detail = await getTitle(id);
    loaded = true;
  }

  onMount(() => {
    void (async () => {
      const current = await getTitle(id);
      if (!current || !app.online || !app.tmdbKey) return;
      const now = Date.now();
      const tmdbDue =
        (current.tmdbId != null && (!current.tmdb || isStale(current.tmdbFetchedAt, tmdbMaxAgeDays(current.tmdb, now), now))) ||
        (current.tmdbId == null && current.imdbId != null) ||
        (current.tmdb != null && current.tmdb.availability?.region !== app.region && current.tmdb.availability != null);
      const omdbDue = current.imdbId != null && app.omdbKey !== '' && isStale(current.omdbFetchedAt, omdbMaxAgeDays(current.year, now), now);
      if (tmdbDue || omdbDue) await update(false);
    })();
  });

  async function update(force: boolean) {
    updating = true;
    updateError = '';
    try {
      await refreshTitle(id, { force });
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    } finally {
      updating = false;
    }
  }

  async function run(action: () => Promise<void>) {
    await action();
    changed();
  }

  function startEditing(rater: Rater) {
    if (!detail) return;
    editing = rater;
    draft = rater === 'US' ? (detail.ratings.US ?? null) : (effectiveRating(detail.ratings, rater).value ?? null);
  }

  async function saveRating() {
    if (!editing) return;
    const rater = editing;
    await run(() => setRating(rater, id, draft));
    editing = null;
  }

  async function saveWatch(input: WatchInput) {
    await markWatched(input);
    logging = false;
    changed();
  }

  /** Two taps for anything destructive: the first arms it, the second does it. */
  function confirm(key: string, action: () => Promise<void>) {
    if (armed !== key) {
      armed = key;
      setTimeout(() => {
        if (armed === key) armed = '';
      }, 4000);
      return;
    }
    armed = '';
    void action();
  }

  async function saveNoteDraft() {
    await run(() => saveNote(id, noteDraft.author, noteDraft.text, noteDraft.id || undefined));
    noteDraft = { id: '', author: 'US', text: '', open: false };
  }

  const tmdb = $derived(detail?.tmdb ?? null);
  const ongoing = $derived(tmdb?.kind === 'series' && tmdb.endYear == null && tmdb.status !== '' && !/ended|cancel/i.test(tmdb.status));
  const years = $derived(detail ? yearSpan(tmdb?.year ?? detail.year, tmdb?.endYear ?? null, detail.kind, ongoing) : '');
  const availabilityStale = $derived(detail?.tmdbFetchedAt != null && Date.now() - detail.tmdbFetchedAt > 30 * DAY_MS);
  const fetchedOn = (at: number | null) =>
    at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  function runtimeText(): string {
    if (!tmdb?.runtime) return '';
    if (tmdb.kind === 'series') return `about ${tmdb.runtime} min an episode`;
    const hours = Math.floor(tmdb.runtime / 60);
    return hours ? `${hours} h ${tmdb.runtime % 60} min` : `${tmdb.runtime} min`;
  }

  function providerGroups(): { label: string; providers: Provider[] }[] {
    const availability = tmdb?.availability;
    if (!availability) return [];
    return [
      { label: 'Stream', providers: availability.stream },
      { label: 'Free', providers: [...availability.free, ...availability.ads] },
      { label: 'Rent', providers: availability.rent },
      { label: 'Buy', providers: availability.buy },
    ].filter((group) => group.providers.length > 0);
  }

  const outcomeText = (completion: number) => (completion >= 1 ? 'finished' : 'partway');
  const whoText = (participants: number) => {
    const who = whoFromParticipants(participants);
    return who === 'both' ? 'Both' : app.profiles[who];
  };
</script>

{#if detail}
  <p class="back"><button type="button" class="link" onclick={() => back({ name: 'library' })}>← Back</button></p>

  <header class="head">
    <div class="poster"><Poster path={tmdb?.posterPath ?? null} name={detail.name} /></div>
    <div class="facts">
      <h1>{detail.name}</h1>
      <p class="muted">
        {[KIND_LABEL[detail.kind], years, runtimeText()].filter(Boolean).join(' · ')}
      </p>
      {#if tmdb?.genres.length}<p class="small">{tmdb.genres.join(', ')}</p>{/if}
      {#if tmdb?.directors.length}
        <p class="small muted">{detail.kind === 'movie' ? 'Directed by' : 'Created by'} {tmdb.directors.join(', ')}</p>
      {/if}
      {#if tmdb?.kind === 'series' && tmdb.seasons}
        <p class="small muted">{tmdb.seasons} season{tmdb.seasons === 1 ? '' : 's'}{tmdb.status ? ` · ${tmdb.status}` : ''}</p>
      {/if}
    </div>
  </header>

  {#if detail.tmdbId == null}
    <p class="notice">
      Not matched to a TMDB entry yet, so there are no details or poster.
      <a {...nav({ name: 'add', query: detail.name, link: detail.id })}>Find it</a>
    </p>
  {/if}
  {#if updating}<p class="muted small" aria-live="polite">Updating details…</p>{/if}
  {#if updateError}<p class="small warn" role="status">{updateError}</p>{/if}

  <section aria-labelledby="ratings">
    <h2 id="ratings">Ratings</h2>
    <ul class="panel rows">
      {#each ['US', ...PROFILE_IDS] as rater (rater)}
        {@const who = rater as Rater}
        {@const effective = who === 'US' ? { value: detail.ratings.US, inherited: false } : effectiveRating(detail.ratings, who)}
        <li>
          {#if editing === who}
            <div class="editor">
              <RatingPicker label={who === 'US' ? 'Agreed rating' : `${personName(who)}'s rating`} bind:value={draft} />
              <div class="actions">
                <button type="button" onclick={saveRating}>Save</button>
                <button type="button" class="secondary" onclick={() => (editing = null)}>Cancel</button>
              </div>
            </div>
          {:else}
            <span class="who">{who === 'US' ? 'Agreed' : personName(who)}</span>
            <span class="value" class:inherited={effective.inherited}>
              {effective.value != null ? formatRating(effective.value) : '–'}
              {#if effective.inherited}<span class="small muted">agreed</span>{/if}
            </span>
            <span class="row-actions">
              {#if who !== 'US' && detail.ratings[who] != null && detail.ratings.US != null}
                <button type="button" class="link" onclick={() => run(() => setRating(who, id, null))}>Use agreed</button>
              {/if}
              <button type="button" class="secondary" onclick={() => startEditing(who)}>
                {effective.value != null && !effective.inherited ? 'Change' : 'Rate'}
              </button>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <section aria-labelledby="status">
    <h2 id="status">Status</h2>
    <ul class="panel rows">
      {#each PROFILE_IDS as person (person)}
        <li class="status-row">
          <label class="who" for={`status-${person}`}>{personName(person)}</label>
          <select
            id={`status-${person}`}
            value={detail.status[person] ?? ''}
            onchange={(event) => run(() => setStatus(person, id, ((event.currentTarget as HTMLSelectElement).value || null) as Status | null))}
          >
            <option value="">No status</option>
            {#each STATUSES as status (status)}
              <option value={status}>{STATUS_LABEL[status]}</option>
            {/each}
          </select>
          <label class="rewatch">
            <input
              type="checkbox"
              checked={detail.wouldRewatch[person] ?? false}
              onchange={(event) => run(() => setWouldRewatch(person, id, (event.currentTarget as HTMLInputElement).checked))}
            />
            Would rewatch
          </label>
        </li>
      {/each}
    </ul>
  </section>

  <section aria-labelledby="watches">
    <h2 id="watches">Watched</h2>
    {#if logging}
      <div class="panel pad">
        <MarkWatched titleId={id} kind={detail.kind} onsave={saveWatch} oncancel={() => (logging = false)} />
      </div>
    {:else}
      <button type="button" onclick={() => (logging = true)}>Mark watched</button>
    {/if}
    {#if detail.events.length > 0}
      <ul class="history">
        {#each detail.events as event (event.id)}
          <li>
            <span>
              {event.watchedOn
                ? new Date(`${event.watchedOn}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
                : 'Date not recorded'}
              · {whoText(event.participants)} · {outcomeText(event.completion)}{event.isRewatch ? ' · rewatch' : ''}{event.source === 'vault' ? ' · imported' : ''}
            </span>
            <button
              type="button"
              class="link"
              onclick={() => confirm(`event-${event.id}`, () => run(() => deleteWatchEvent(event.id)))}
            >
              {armed === `event-${event.id}` ? 'Tap to remove' : 'Remove'}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if tmdb}
    <section aria-labelledby="where" class:stale={availabilityStale}>
      <h2 id="where">Where to watch in {app.region}</h2>
      {#if tmdb.availability && tmdb.availability.region === app.region}
        {#each providerGroups() as group (group.label)}
          <div class="providers">
            <span class="muted small">{group.label}</span>
            <ul>
              {#each group.providers as provider (provider.id)}
                <li>
                  {#if provider.logoPath}
                    <img src={logoUrl(provider.logoPath)} alt="" crossorigin="anonymous" loading="lazy" width="28" height="28" />
                  {/if}
                  {provider.name}
                </li>
              {/each}
            </ul>
          </div>
        {:else}
          <p class="small muted">No streaming, rental or purchase options listed.</p>
        {/each}
      {:else if tmdb.availability}
        <p class="small muted">Availability was saved for {tmdb.availability.region}. Update details to see {app.region}.</p>
      {:else}
        <p class="small muted">Not listed as available in {app.region}.</p>
      {/if}
      <p class="credit">
        Availability data from JustWatch, as of {fetchedOn(detail.tmdbFetchedAt)}{availabilityStale ? '; it may be out of date' : ''}.
      </p>
    </section>
  {/if}

  {#if detail.omdb || tmdb?.voteAverage}
    <section aria-labelledby="scores">
      <h2 id="scores">Scores</h2>
      <ul class="scores">
        {#if detail.omdb?.imdbRating != null}
          <li><strong>{detail.omdb.imdbRating}</strong><span>IMDb{detail.omdb.imdbVotes ? ` · ${detail.omdb.imdbVotes.toLocaleString()} votes` : ''}</span></li>
        {/if}
        {#if detail.omdb?.rottenTomatoes != null}
          <li><strong>{detail.omdb.rottenTomatoes}%</strong><span>Rotten Tomatoes</span></li>
        {/if}
        {#if detail.omdb?.metacritic != null}
          <li><strong>{detail.omdb.metacritic}</strong><span>Metacritic</span></li>
        {/if}
        {#if tmdb?.voteAverage}
          <li><strong>{tmdb.voteAverage.toFixed(1)}</strong><span>TMDB · {tmdb.voteCount.toLocaleString()} votes</span></li>
        {/if}
      </ul>
      <p class="credit">
        {detail.omdb ? `IMDb, Rotten Tomatoes and Metacritic scores via OMDb, as of ${fetchedOn(detail.omdbFetchedAt)}.` : ''}
        {tmdb?.voteAverage ? 'TMDB score from TMDB.' : ''}
      </p>
    </section>
  {/if}

  {#if tmdb}
    <section aria-labelledby="about">
      <h2 id="about">About</h2>
      {#if tmdb.overview}<p>{tmdb.overview}</p>{/if}
      {#if tmdb.cast.length}
        <p class="small"><span class="muted">Starring</span> {tmdb.cast.slice(0, 5).map((person) => person.name).join(', ')}</p>
      {/if}
      <p class="credit">
        Title details from TMDB, as of {fetchedOn(detail.tmdbFetchedAt)}.
        {#if app.online && app.tmdbKey}
          <button type="button" class="link" disabled={updating} onclick={() => update(true)}>Update details</button>
        {/if}
      </p>
    </section>
  {/if}

  <section aria-labelledby="notes">
    <h2 id="notes">Notes</h2>
    {#each detail.notes as note (note.id)}
      <div class="note">
        <p class="small muted">{note.author === 'US' ? 'Both of you' : personName(note.author)}</p>
        <p class="note-text">{note.text}</p>
        <button type="button" class="link" onclick={() => (noteDraft = { id: note.id, author: note.author, text: note.text, open: true })}>
          Edit
        </button>
      </div>
    {/each}
    {#if noteDraft.open}
      <div class="panel pad note-editor">
        <label>
          <span class="muted small">Written by</span>
          <select bind:value={noteDraft.author}>
            <option value="US">Both of you</option>
            <option value="A">{app.profiles.A}</option>
            <option value="B">{app.profiles.B}</option>
          </select>
        </label>
        <label>
          <span class="visually-hidden">Note</span>
          <textarea bind:value={noteDraft.text} rows="5"></textarea>
        </label>
        <div class="actions">
          <button type="button" onclick={saveNoteDraft}>{noteDraft.id && !noteDraft.text.trim() ? 'Delete note' : 'Save note'}</button>
          <button type="button" class="secondary" onclick={() => (noteDraft = { id: '', author: 'US', text: '', open: false })}>Cancel</button>
        </div>
      </div>
    {:else}
      <button type="button" class="secondary" onclick={() => (noteDraft = { id: '', author: 'US', text: '', open: true })}>Add a note</button>
    {/if}
  </section>

  <section class="remove">
    <button
      type="button"
      class="danger"
      onclick={() => confirm('remove', async () => {
        await removeTitle(id);
        changed();
        go({ name: 'library' }, { replace: true });
      })}
    >
      {armed === 'remove' ? 'Tap again to remove it and everything recorded about it' : 'Remove from library'}
    </button>
  </section>
{:else if loaded}
  <p class="muted">This title is not in the library.</p>
  <a {...nav({ name: 'library' })}>Back to the library</a>
{/if}

<style>
  .back {
    margin: -0.5rem 0 0.25rem;
  }
  .head {
    display: grid;
    grid-template-columns: 7.5rem 1fr;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  .facts p {
    margin: 0.3rem 0 0;
  }
  section {
    margin-top: 1.5rem;
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rows li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.6rem 0.9rem;
  }
  .rows li + li {
    border-top: 1px solid var(--line);
  }
  .who {
    min-width: 5rem;
    font-weight: 600;
  }
  .value {
    font-size: 1.15rem;
    font-weight: 600;
  }
  .value.inherited {
    color: var(--muted);
    font-weight: 500;
  }
  .row-actions {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
  }
  .editor {
    width: 100%;
    display: grid;
    gap: 0.75rem;
  }
  .status-row select {
    flex: 1 1 10rem;
    width: auto;
  }
  .rewatch {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 2.75rem;
    font-size: 0.9rem;
  }
  .rewatch input {
    width: 1.25rem;
    min-height: 1.25rem;
    height: 1.25rem;
  }
  .pad {
    padding: 1rem;
  }
  .actions {
    display: flex;
    gap: 0.75rem;
  }
  .history {
    margin: 0.75rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.9rem;
  }
  .history li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border-bottom: 1px solid var(--line);
  }
  .providers {
    display: grid;
    gap: 0.3rem;
    margin-bottom: 0.6rem;
  }
  .providers ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .providers li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9rem;
  }
  .providers img {
    border-radius: 0.35rem;
  }
  .stale .providers {
    opacity: 0.55;
  }
  .scores {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .scores li {
    display: grid;
  }
  .scores strong {
    font-size: 1.2rem;
  }
  .scores span {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .credit {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .note {
    margin-bottom: 0.75rem;
  }
  .note p {
    margin: 0;
  }
  .note-text {
    white-space: pre-wrap;
  }
  .note-editor {
    display: grid;
    gap: 0.75rem;
  }
  .note-editor label {
    display: grid;
    gap: 0.25rem;
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
  .remove {
    margin-top: 2.5rem;
  }
  @media (min-width: 40rem) {
    .head {
      grid-template-columns: 11rem 1fr;
    }
  }
</style>
