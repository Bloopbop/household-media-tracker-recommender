<script lang="ts">
  import { localToday } from '../lib/library';
  import { DRAWS, MIN_NEUTRAL, runBacktest, TEST_SHARE, type GroupMeans, type ListResult, type ModeBacktest } from '../lib/rec/backtest';
  import { loadRecInput } from '../lib/rec/data';
  import { buildSlates } from '../lib/rec/engine';
  import { monthSeed } from '../lib/rec/random';
  import type { Mode, Weights } from '../lib/rec/types';
  import { back } from '../lib/router.svelte';
  import { app } from '../lib/state.svelte';

  /** The MVP gate (spec, section 5). */
  const GATE_LIFT = 0.05;
  const GATE_MS = 1500;

  interface Run {
    modes: ModeBacktest[];
    loadMs: number;
    slateMs: number;
    backtestMs: number;
    seed: number;
    library: number;
    candidates: number;
    neutral: number;
    at: Date;
  }

  let running = $state(false);
  let result = $state<Run | null>(null);
  let error = $state('');
  let copied = $state('');

  const label = (mode: Mode) => (mode === 'US' ? 'Together' : app.profiles[mode]);
  const fixed = (value: number) => value.toFixed(2);
  const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
  const ms = (value: number) => `${Math.round(value).toLocaleString()} ms`;
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const opt = (value: number | null) => (value == null ? '–' : fixed(value));
  const balance = (weights: Weights) => `content ${fixed(weights.content)}, collaborative ${fixed(weights.collaborative)}, quality ${fixed(weights.quality)}`;

  async function run() {
    running = true;
    error = '';
    copied = '';
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const started = performance.now();
      const input = await loadRecInput();
      const loaded = performance.now();
      buildSlates(input);
      const built = performance.now();
      const seed = monthSeed(new Date());
      const modes = runBacktest(input, seed);
      const finished = performance.now();
      const libraryKeys = new Set(input.library.map((title) => title.key).filter(Boolean));
      const candidates = [...input.pool.entries()].filter(([key]) => !libraryKeys.has(key) && input.features.has(key));
      result = {
        modes,
        loadMs: loaded - started,
        slateMs: built - loaded,
        backtestMs: finished - built,
        seed,
        library: input.library.length,
        candidates: candidates.length,
        neutral: candidates.filter(([, sources]) => sources.length > 0 && sources.every((source) => ['trending', 'popular', 'services'].includes(source))).length,
        at: new Date(),
      };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      running = false;
    }
  }

  const liftPasses = $derived(result != null && result.modes.every((mode) => mode.lift != null && mode.lift >= GATE_LIFT));
  const tunedPasses = $derived(result != null && result.modes.every((mode) => mode.tuned != null && mode.tuned.freshLift >= GATE_LIFT));
  const speedPasses = $derived(app.slateShownMs != null && app.slateShownMs < GATE_MS);

  const four = (g: Record<'liked' | 'other' | 'neutral' | 'pool', GroupMeans>, pick: (m: GroupMeans) => string) =>
    [g.liked, g.other, g.neutral, g.pool].map(pick).join('/');
  const groupText = (g: Record<'liked' | 'other' | 'neutral' | 'pool', GroupMeans>) =>
    `content ${four(g, (m) => opt(m.content))}, with collab ${four(g, (m) => pct(m.withCollaborative))}, ` +
    `collab ${four(g, (m) => opt(m.collaborative))}, quality ${four(g, (m) => opt(m.quality))}`;
  const listText = (list: ListResult) =>
    `P@10 model ${fixed(list.measures.model.precision)} scores ${fixed(list.measures.baseline.precision)} chance ${fixed(list.chance)}; ` +
    `AUC model ${fixed(list.measures.model.auc)} scores ${fixed(list.measures.baseline.auc)}; ` +
    `content ${fixed(list.measures.content.precision)} (AUC ${fixed(list.measures.content.auc)}) collab ${fixed(list.measures.collaborative.precision)} (AUC ${fixed(list.measures.collaborative.auc)})`;

  function resultsText(run: Run): string {
    const lines = [
      `Recommendation check 2, ${localToday(run.at)}, version ${__APP_VERSION__}`,
      `Library ${run.library} titles; ${run.candidates} candidates with details (${run.neutral} from trending, popular or services only)`,
      `Seed ${run.seed}, ${DRAWS} draws (+${DRAWS} fresh for the best balance), ${Math.round(TEST_SHARE * 100)}% hidden`,
    ];
    for (const mode of run.modes) {
      if (!mode.within) {
        lines.push(`${mode.mode}: not enough rated titles with details (${mode.rated})`);
        continue;
      }
      lines.push(`${mode.mode}: rated ${mode.rated}, hidden ${mode.testSize}, favourites ${mode.relevant.toFixed(1)} (${mode.likedPoint}+)`);
      lines.push(
        mode.neutral
          ? `${mode.mode} vs neutral (${mode.neutral.candidates}): ${listText(mode.neutral)}; lift ${signed(mode.lift ?? 0)}`
          : `${mode.mode} vs neutral: too few (${mode.neutralAvailable} of ${MIN_NEUTRAL})`,
      );
      if (mode.tuned) {
        lines.push(
          `${mode.mode} best c${fixed(mode.tuned.weights.content)} f${fixed(mode.tuned.weights.collaborative)} q${fixed(mode.tuned.weights.quality)}: ` +
            `train ${fixed(mode.tuned.train)}, fresh ${fixed(mode.tuned.fresh)} vs scores ${fixed(mode.tuned.freshBaseline)}, lift ${signed(mode.tuned.freshLift)}`,
        );
      }
      lines.push(`${mode.mode} among rated: ${listText(mode.within)}`);
      if (mode.pool) lines.push(`${mode.mode} vs pool (${mode.pool.candidates}): ${listText(mode.pool)}`);
      if (mode.groups) lines.push(`${mode.mode} means fav/other/neutral/pool: ${groupText(mode.groups)}`);
    }
    lines.push(
      `Timing: open to picks ${app.slateShownMs != null ? ms(app.slateShownMs) : 'not measured'}; load ${ms(run.loadMs)}; slates ${ms(run.slateMs)}; check ${ms(run.backtestMs)}`,
      `Gate vs neutral, current balance: lift ${GATE_LIFT}+ in every mode ${liftPasses ? 'pass' : 'not yet'}; best balance on fresh draws ${tunedPasses ? 'pass' : 'not yet'}; picks under 1.5 s ${speedPasses ? 'pass' : 'not yet'}`,
    );
    return lines.join('\n');
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(resultsText(result));
      copied = 'Copied.';
    } catch {
      copied = 'Copying was blocked. Select the text below instead.';
    }
  }
</script>

<p class="back"><button type="button" class="link" onclick={() => back({ name: 'settings' })}>← Settings</button></p>
<h1>Recommendation check</h1>
<p class="lede">
  This hides a random fifth of your ratings and rebuilds the recommender without them. It then mixes the hidden titles with
  up to 200 you haven't seen, taken from trending, popular and your services' titles, which were chosen without your taste,
  and counts how many of your hidden favourites come out in the top 10. It compares that with ranking the same list by
  review scores alone. It repeats this {DRAWS} times and averages, and tries other balances of the parts, testing the best
  on {DRAWS} fresh draws. Nothing leaves this device.
</p>

<button type="button" disabled={running} onclick={run}>{running ? 'Checking…' : result ? 'Run the check again' : 'Run the check'}</button>
{#if error}<p class="warn" role="alert">{error}</p>{/if}

{#if result}
  <section aria-labelledby="verdict" class="panel verdict">
    <h2 id="verdict">Phase 2 gate</h2>
    <p class:pass={liftPasses}>
      {liftPasses ? 'Pass' : 'Not yet'}: the recommender finds more of your hidden favourites than review scores alone, by at
      least {GATE_LIFT}, in every mode.
    </p>
    <p class:pass={tunedPasses} class="secondary-line">
      With the best balance found: {tunedPasses ? 'it would pass' : 'it would not pass yet'}, on fresh draws.
    </p>
    <p class:pass={speedPasses}>
      {speedPasses ? 'Pass' : 'Not yet'}: picks on screen within 1.5 seconds of opening the app
      ({app.slateShownMs != null ? ms(app.slateShownMs) : 'not measured this session'}).
    </p>
    <p class="small muted">For a fair timing, close the app fully, reopen it on For you, then come back here.</p>
  </section>

  {#each result.modes as mode (mode.mode)}
    <section class="panel mode" aria-label={label(mode.mode)}>
      <h2>{label(mode.mode)}</h2>
      {#if mode.neutral && mode.tuned && mode.within}
        <table>
          <thead>
            <tr><th>Favourites among unseen titles</th><th>Recom­mender</th><th>Scores alone</th><th>Chance</th></tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">In the top 10</th>
              <td>{fixed(mode.neutral.measures.model.precision)}</td>
              <td>{fixed(mode.neutral.measures.baseline.precision)}</td>
              <td>{fixed(mode.neutral.chance)}</td>
            </tr>
            <tr>
              <th scope="row">Ranked above an unseen title</th>
              <td>{pct(mode.neutral.measures.model.auc)}</td>
              <td>{pct(mode.neutral.measures.baseline.auc)}</td>
              <td>50%</td>
            </tr>
          </tbody>
        </table>
        <p class="lift" class:pass={mode.lift != null && mode.lift >= GATE_LIFT}>Lift {signed(mode.lift ?? 0)}</p>
        <p class="small">
          Best balance found: {balance(mode.tuned.weights)}. On fresh draws it finds {fixed(mode.tuned.fresh)} against
          {fixed(mode.tuned.freshBaseline)} for scores alone (lift {signed(mode.tuned.freshLift)}).
        </p>
        <p class="small muted">
          From {mode.rated} rated titles: {mode.testSize} hidden each time, about {mode.relevant.toFixed(1)} of them favourites
          (rated {mode.likedPoint} or more), among {mode.neutral.candidates} unseen titles.
        </p>
        <p class="small muted">
          Ranking only your hidden rated titles against each other, a favourite comes above another title
          {pct(mode.within.measures.model.auc)} of the time with the recommender and {pct(mode.within.measures.baseline.auc)}
          with scores alone.
          {#if mode.pool}
            Against titles from your own pool, which resemble your favourites, the recommender finds
            {fixed(mode.pool.measures.model.precision)} and scores alone {fixed(mode.pool.measures.baseline.precision)}.
          {/if}
        </p>
      {:else if mode.within}
        <p class="muted">
          Not enough unseen titles chosen without your taste yet: {mode.neutralAvailable} of the {MIN_NEUTRAL} needed. In
          Settings, tap Gather candidates now, wait for it to finish, then run the check again.
        </p>
      {:else}
        <p class="muted">Not enough to check yet: {mode.rated} rated titles with details. It needs 25.</p>
      {/if}
    </section>
  {/each}

  <section class="panel timing" aria-labelledby="timing">
    <h2 id="timing">Timing on this device</h2>
    <ul class="small">
      <li>Opening the app to picks on screen: {app.slateShownMs != null ? ms(app.slateShownMs) : 'not measured this session'}</li>
      <li>Loading the data: {ms(result.loadMs)}; building all three lists: {ms(result.slateMs)}</li>
      <li>This check: {ms(result.backtestMs)}</li>
    </ul>
  </section>

  <div class="copy">
    <button type="button" class="secondary" onclick={copy}>Copy results</button>
    {#if copied}<span class="small muted" role="status">{copied}</span>{/if}
  </div>
  <pre class="results small">{resultsText(result)}</pre>
  <p class="small muted">The results are numbers only: no titles, ratings or TMDB data.</p>
{/if}

<style>
  .back {
    margin: -0.5rem 0 0.25rem;
  }
  .lede {
    margin: 0.5rem 0 1rem;
    color: var(--muted);
  }
  .warn {
    color: var(--warn);
  }
  .panel {
    margin-top: 1rem;
    padding: 0.9rem 1rem;
  }
  .panel h2 {
    margin-top: 0;
  }
  .verdict p {
    margin: 0.35rem 0;
    color: var(--warn);
    font-weight: 600;
  }
  .verdict p.secondary-line {
    font-weight: 500;
  }
  .verdict p.small {
    font-weight: 400;
    color: var(--muted);
  }
  .pass {
    color: var(--good) !important;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  th,
  td {
    padding: 0.35rem 0.25rem;
    text-align: right;
    border-bottom: 1px solid var(--line);
    vertical-align: bottom;
  }
  th[scope='row'],
  thead th:first-child {
    text-align: left;
    font-weight: 500;
  }
  thead th {
    font-weight: 600;
  }
  td {
    font-variant-numeric: tabular-nums;
  }
  .lift {
    margin: 0.6rem 0 0.3rem;
    font-weight: 700;
    color: var(--warn);
  }
  .mode p.small {
    margin: 0.35rem 0;
  }
  .timing ul {
    margin: 0;
    padding-left: 1.1rem;
  }
  .copy {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }
  .results {
    margin: 0.75rem 0 0;
    padding: 0.75rem;
    overflow-x: auto;
    white-space: pre-wrap;
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    background: var(--panel);
  }
</style>
