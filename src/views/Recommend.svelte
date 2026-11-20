<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Poster from '../components/Poster.svelte';
  import RatingPicker from '../components/RatingPicker.svelte';
  import { refreshSlates, runRecJob } from '../lib/rec/job';
  import { logImpression, react, REACTION_LABEL, reactionsFor, type Done, type Reaction, type Target } from '../lib/rec/reactions';
  import { getLastMode, loadSlate, setLastMode, type StoredPick, type StoredSlate } from '../lib/rec/store';
  import { MODES, type Mode } from '../lib/rec/types';
  import { nav } from '../lib/router.svelte';
  import { app } from '../lib/state.svelte';
  import { KIND_LABEL, type ProfileId } from '../lib/types';

  let mode = $state<Mode | null>(null);
  let slate = $state<StoredSlate | null>(null);
  let loaded = $state(false);
  /** The pick whose Seen it is asking for a rating. */
  let rating = $state<{ key: string; value: number | null } | null>(null);
  let busy = $state(false);
  let failure = $state('');
  /** The last reaction, while it can still be undone. */
  let done = $state<Done | null>(null);
  let doneTimer: ReturnType<typeof setTimeout> | undefined;

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
  const listLabel = (people: ProfileId[]) =>
    mode !== 'US' ? 'On your list' : people.length === 2 ? 'On both lists' : `On ${app.profiles[people[0]]}'s list`;
  const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  async function respond(pick: StoredPick, position: number, reaction: Reaction) {
    if (!mode || busy) return;
    // Seen it asks for a rating first.
    if (reaction === 'seen' && rating?.key !== pick.key) {
      rating = { key: pick.key, value: null };
      return;
    }
    busy = true;
    failure = '';
    try {
      const result = await react({ mode, pick, position }, reaction, reaction === 'seen' ? (rating?.value ?? null) : null);
      rating = null;
      done = result;
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => (done = null), 8000);
    } catch (error) {
      failure = `That didn't save: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
    }
  }

  async function undo() {
    const last = done;
    done = null;
    clearTimeout(doneTimer);
    if (last) await last.undo();
  }

  // Impressions: a pick counts as shown once half of it is on screen.
  const targets = new Map<Element, Target>();
  let observer: IntersectionObserver | undefined;

  function shown(node: HTMLElement, target: Target) {
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const current = targets.get(entry.target);
          if (entry.isIntersecting && current) logImpression(current);
        }
      },
      { threshold: 0.5 },
    );
    targets.set(node, target);
    observer.observe(node);
    return {
      update(next: Target) {
        targets.set(node, next);
      },
      destroy() {
        targets.delete(node);
        observer?.unobserve(node);
      },
    };
  }

  onDestroy(() => {
    observer?.disconnect();
    clearTimeout(doneTimer);
  });
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
    {#each slate.picks as pick, index (pick.key)}
      <li use:shown={{ mode, pick, position: index + 1 }}>
        <a class="pick" {...nav({ name: 'pick', key: pick.key, mode })}>
          <span class="thumb"><Poster path={pick.posterPath} name={pick.name} /></span>
          <span class="text">
            <span class="name">{pick.name}</span>
            <span class="meta">{KIND_LABEL[pick.kind]}{pick.year ? ` · ${pick.year}` : ''} · {pick.evidence.availability.label}</span>
            <span class="reason">{pick.reason}</span>
            {#if pick.exploratory || pick.rewatch || pick.listedBy.length}
              <span class="tags">
                {#if pick.exploratory}<span class="tag">Exploratory</span>{/if}
                {#if pick.rewatch}<span class="tag">Rewatch</span>{/if}
                {#if pick.listedBy.length}<span class="tag">{listLabel(pick.listedBy)}</span>{/if}
              </span>
            {/if}
          </span>
        </a>
        {#if rating?.key === pick.key}
          <div class="seen">
            <RatingPicker bind:value={rating.value} label={mode === 'US' ? 'Your agreed rating' : `${app.profiles[mode]}'s rating`} />
            <div class="seen-actions">
              <button type="button" disabled={busy} onclick={() => respond(pick, index + 1, 'seen')}>
                {rating.value == null ? 'Save without a rating' : 'Save'}
              </button>
              <button type="button" class="link" onclick={() => (rating = null)}>Cancel</button>
            </div>
          </div>
        {:else}
          <div class="reactions" role="group" aria-label={`Your reaction to ${pick.name}`}>
            {#each reactionsFor(pick, mode) as reaction (reaction)}
              <button type="button" class="react" disabled={busy} onclick={() => respond(pick, index + 1, reaction)}>
                {REACTION_LABEL[reaction]}
              </button>
            {/each}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
  {#if failure}<p class="warn small" role="alert">{failure}</p>{/if}
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

{#if done}
  <div class="done" role="status">
    <span>{done.message}</span>
    <button type="button" class="link" onclick={undo}>Undo</button>
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
  .slate li {
    display: grid;
    gap: 0.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--line);
  }
  .reactions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(4.5rem, 1fr));
    gap: 0.35rem;
  }
  .react {
    min-height: 2.75rem;
    padding: 0.25rem 0.35rem;
    border-color: var(--line);
    background: var(--panel);
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1.15;
    text-align: center;
  }
  .seen {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
  }
  .seen-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .done {
    position: fixed;
    inset: auto 1rem calc(4rem + env(safe-area-inset-bottom)) 1rem;
    z-index: 11;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    max-width: 46rem;
    margin: 0 auto;
    padding: 0.25rem 0.5rem 0.25rem 1rem;
    border-radius: var(--radius);
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.9rem;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
  }
  .done .link {
    color: var(--on-accent);
    font-weight: 700;
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
