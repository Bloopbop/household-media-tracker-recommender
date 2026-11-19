<script lang="ts">
  import Poster from '../components/Poster.svelte';
  import { DAY_MS } from '../lib/gateway/policy';
  import { logoUrl } from '../lib/gateway/tmdb';
  import { yearSpan } from '../lib/library';
  import { formatRating } from '../lib/ratings';
  import { loadCandidate, loadPick, type CandidateDetail } from '../lib/rec/store';
  import type { ComponentName, Mode, SlatePick } from '../lib/rec/types';
  import { back, nav } from '../lib/router.svelte';
  import { app } from '../lib/state.svelte';
  import { KIND_LABEL, type Provider } from '../lib/types';

  let { key, mode }: { key: string; mode: Mode } = $props();

  let detail = $state<CandidateDetail | null>(null);
  let pick = $state<SlatePick | null>(null);

  $effect(() => {
    void app.slatesVersion;
    void Promise.all([loadCandidate(key), loadPick(mode, key)]).then(([candidate, saved]) => {
      detail = candidate;
      pick = saved;
    });
  });

  const tmdb = $derived(detail?.tmdb ?? null);
  const name = $derived(tmdb?.name ?? pick?.name ?? '');
  const ongoing = $derived(tmdb?.kind === 'series' && tmdb.endYear == null && !/ended|cancel/i.test(tmdb.status));
  const years = $derived(tmdb ? yearSpan(tmdb.year, tmdb.endYear, tmdb.kind, ongoing) : pick?.year ? String(pick.year) : '');
  const modeLabel = $derived(mode === 'US' ? 'the two of you' : app.profiles[mode]);
  const fetchedOn = (at: number | null) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

  function runtimeText(): string {
    if (!tmdb?.runtime) return '';
    if (tmdb.kind === 'series') return `about ${tmdb.runtime} min an episode`;
    const hours = Math.floor(tmdb.runtime / 60);
    return hours ? `${hours} h ${tmdb.runtime % 60} min` : `${tmdb.runtime} min`;
  }

  function providerGroups(): { label: string; providers: Provider[] }[] {
    const availability = tmdb?.availability;
    if (!availability || availability.region !== app.region) return [];
    return [
      { label: 'Stream', providers: availability.stream },
      { label: 'Free', providers: [...availability.free, ...availability.ads] },
      { label: 'Rent', providers: availability.rent },
      { label: 'Buy', providers: availability.buy },
    ].filter((group) => group.providers.length > 0);
  }

  const PARTS: { name: ComponentName; label: string; about: string }[] = [
    { name: 'content', label: 'Content', about: 'how close it is to what you rated well' },
    { name: 'collaborative', label: 'Collaborative', about: 'whether TMDB recommends it beside titles you rated well, more than beside ones you didn’t' },
    { name: 'quality', label: 'Quality', about: 'review and audience scores' },
    { name: 'partner', label: 'Partner', about: "the other person's rating" },
  ];

  /** Each part is a percentile among this list's candidates (0 to 1). */
  const percent = (value: number) => Math.round(value * 100);
  const weighted = $derived(!pick?.exploratory && !pick?.rewatch);
  const scoresLine = $derived.by(() => {
    const external = pick?.evidence.external;
    if (!external) return '';
    return [
      external.imdb != null ? `IMDb ${external.imdb}${external.imdbVotes ? ` (${external.imdbVotes.toLocaleString()} votes)` : ''}` : '',
      external.rt != null ? `Rotten Tomatoes ${external.rt}%` : '',
      external.mc != null ? `Metacritic ${external.mc}` : '',
      external.tmdb != null ? `TMDB ${external.tmdb.toFixed(1)} (${external.tmdbVotes.toLocaleString()} votes)` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });
</script>

<p class="back"><button type="button" class="link" onclick={() => back({ name: 'recommend' })}>← Back</button></p>

{#if detail}
  <header class="head">
    <div class="poster"><Poster path={tmdb?.posterPath ?? pick?.posterPath ?? null} {name} /></div>
    <div class="facts">
      <h1>{name}</h1>
      <p class="muted">{[tmdb ? KIND_LABEL[tmdb.kind] : '', years, runtimeText()].filter(Boolean).join(' · ')}</p>
      {#if tmdb?.genres.length}<p class="small">{tmdb.genres.join(', ')}</p>{/if}
      {#if tmdb?.directors.length}
        <p class="small muted">{tmdb.kind === 'movie' ? 'Directed by' : 'Created by'} {tmdb.directors.join(', ')}</p>
      {/if}
      {#if pick?.exploratory || pick?.rewatch}
        <p class="tags">
          {#if pick.exploratory}<span class="tag">Exploratory</span>{/if}
          {#if pick.rewatch}<span class="tag">Rewatch</span>{/if}
        </p>
      {/if}
      {#if detail.titleId}
        <p class="small"><a {...nav({ name: 'title', id: detail.titleId })}>In your library</a></p>
      {/if}
    </div>
  </header>

  <section aria-labelledby="why">
    <h2 id="why">Why this?</h2>
    {#if pick}
      <p class="reason">{pick.reason}</p>
      <ul class="parts panel">
        {#each PARTS as part (part.name)}
          {@const value = pick.components[part.name]}
          {@const weight = pick.evidence.weights[part.name]}
          <li>
            <div class="part-head">
              <span class="part-name">{part.label}</span>
              <span class="small muted">{part.about}</span>
            </div>
            {#if part.name === 'partner'}
              <p class="small muted">Off until you each have 30 ratings of your own.</p>
            {:else if value == null}
              <p class="small muted">No data for this title.</p>
            {:else}
              <div class="bar-row">
                <span class="bar"><span style={`width: ${percent(value)}%`}></span></span>
                <span class="num">{percent(value)}%</span>
              </div>
              <p class="small muted">
                Higher than {percent(value)}% of the other candidates{#if weighted && weight != null}; counts for {percent(weight)}% of the score{/if}.
              </p>
            {/if}
          </li>
        {/each}
      </ul>
      {#if pick.exploratory}
        <p class="small muted">
          Exploratory picks are scored from content (70%) and quality (30%) alone, and only fill the exploratory places.
        </p>
      {:else if pick.rewatch}
        <p class="small muted">Rewatches are scored from the rating already given.</p>
      {/if}
      <ul class="evidence small">
        {#each pick.evidence.seeds as seed (seed.name)}
          <li>Most like <strong>{seed.name}</strong> (rated {formatRating(seed.rating)}): shares {seed.features.join(', ')}.</li>
        {/each}
        {#if pick.evidence.recommendedBy.length}
          <li>TMDB recommends it alongside {pick.evidence.recommendedBy.join(' and ')}.</li>
        {/if}
        {#if scoresLine}<li>{scoresLine}.</li>{/if}
        <li>{pick.evidence.availability.label} (score × {pick.evidence.availability.factor.toFixed(2)}).</li>
      </ul>
      <p class="small muted">Score {pick.score.toFixed(2)}, for {modeLabel}.</p>
    {:else}
      <p class="muted">This title is not among the current picks for {modeLabel}.</p>
    {/if}
  </section>

  {#if tmdb}
    <section aria-labelledby="where" class:stale={detail.tmdbFetchedAt != null && Date.now() - detail.tmdbFetchedAt > 30 * DAY_MS}>
      <h2 id="where">Where to watch in {app.region}</h2>
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
        <p class="small muted">Not listed as available in {app.region}.</p>
      {/each}
      <p class="credit">Availability data from JustWatch, as of {fetchedOn(detail.tmdbFetchedAt)}.</p>
    </section>

    <section aria-labelledby="about">
      <h2 id="about">About</h2>
      {#if tmdb.overview}<p>{tmdb.overview}</p>{/if}
      {#if tmdb.cast.length}
        <p class="small"><span class="muted">Starring</span> {tmdb.cast.slice(0, 5).map((person) => person.name).join(', ')}</p>
      {/if}
      <p class="credit">
        Title details from TMDB, as of {fetchedOn(detail.tmdbFetchedAt)}.
        {#if detail.omdb}IMDb, Rotten Tomatoes and Metacritic scores via OMDb, as of {fetchedOn(detail.omdbFetchedAt)}.{/if}
      </p>
    </section>
  {:else}
    <p class="muted">The details for this title are not saved on this device yet.</p>
  {/if}

  {#if !detail.titleId}
    <p class="small add"><a {...nav({ name: 'add', query: name })}>Add it to the library</a></p>
  {/if}
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
  .reason {
    font-weight: 600;
  }
  .parts {
    margin: 0.75rem 0;
    padding: 0;
    list-style: none;
  }
  .parts li {
    display: grid;
    gap: 0.35rem;
    padding: 0.65rem 0.9rem;
  }
  .parts li + li {
    border-top: 1px solid var(--line);
  }
  .parts p {
    margin: 0;
  }
  .part-head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem 0.6rem;
    align-items: baseline;
  }
  .part-name {
    font-weight: 600;
  }
  .bar-row {
    display: grid;
    grid-template-columns: 1fr 2.75rem;
    gap: 0.6rem;
    align-items: center;
  }
  .bar {
    height: 0.6rem;
    border-radius: 999px;
    background: var(--poster-bg);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    font-size: 0.85rem;
  }
  .evidence {
    margin: 0.5rem 0;
    padding-left: 1.1rem;
  }
  .evidence li + li {
    margin-top: 0.3rem;
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
  .credit {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .add {
    margin-top: 2rem;
  }
  @media (min-width: 40rem) {
    .head {
      grid-template-columns: 11rem 1fr;
    }
  }
</style>
