<script lang="ts">
  import { DRAWS, POOL_SAMPLE, runBacktest, TEST_SHARE, type ModeBacktest } from '../lib/rec/backtest';
  import { loadRecInput } from '../lib/rec/data';
  import { localToday } from '../lib/library';
  import { buildSlates } from '../lib/rec/engine';
  import { monthSeed } from '../lib/rec/random';
  import type { Mode } from '../lib/rec/types';
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
      result = {
        modes,
        loadMs: loaded - started,
        slateMs: built - loaded,
        backtestMs: finished - built,
        seed,
        library: input.library.length,
        candidates: [...input.pool.keys()].filter((key) => !libraryKeys.has(key) && input.features.has(key)).length,
        at: new Date(),
      };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      running = false;
    }
  }

  const liftPasses = $derived(result != null && result.modes.every((mode) => mode.lift != null && mode.lift >= GATE_LIFT));
  const speedPasses = $derived(result != null && app.slateShownMs != null && app.slateShownMs < GATE_MS);

  function resultsText(run: Run): string {
    const lines = [
      `Recommendation check, ${localToday(run.at)}, version ${__APP_VERSION__}`,
      `Library ${run.library} titles; ${run.candidates} candidates with details`,
      `Seed ${run.seed}, ${DRAWS} draws, ${Math.round(TEST_SHARE * 100)}% hidden, up to ${POOL_SAMPLE} candidates`,
    ];
    for (const mode of run.modes) {
      const r = mode.results;
      lines.push(
        r
          ? `${mode.mode}: rated ${mode.rated}, hidden ${mode.testSize}, liked in hidden ${mode.relevant.toFixed(1)}, liked at ${mode.likedPoint}+, candidates ${mode.poolSample} | ` +
              `P@10 model ${fixed(r.model.precision)} baseline ${fixed(r.baseline.precision)} lift ${signed(mode.lift ?? 0)} | ` +
              `R@10 model ${fixed(r.model.recall)} baseline ${fixed(r.baseline.recall)} | ` +
              `content ${fixed(r.content.precision)} collab ${fixed(r.collaborative.precision)} collab-as-zero ${fixed(r.cfZero.precision)}`
          : `${mode.mode}: not enough rated titles with details (${mode.rated}) or no candidates (${mode.poolSample})`,
      );
    }
    lines.push(
      `Timing: open to picks ${app.slateShownMs != null ? ms(app.slateShownMs) : 'not measured'}; load ${ms(run.loadMs)}; slates ${ms(run.slateMs)}; check ${ms(run.backtestMs)}`,
      `Gate: lift ${GATE_LIFT}+ in every mode ${liftPasses ? 'pass' : 'not yet'}; picks under 1.5 s ${speedPasses ? 'pass' : 'not yet'}`,
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
  This hides a random fifth of your ratings, rebuilds the recommender without them, and checks whether the hidden titles
  you liked come out near the top of a list that also holds {POOL_SAMPLE} candidates you haven't seen. It compares the result
  with ranking by review and audience scores alone. It repeats this {DRAWS} times and reports the average. Nothing
  leaves this device.
</p>

<button type="button" disabled={running} onclick={run}>{running ? 'Checking…' : result ? 'Run the check again' : 'Run the check'}</button>
{#if error}<p class="warn" role="alert">{error}</p>{/if}

{#if result}
  <section aria-labelledby="verdict" class="panel verdict">
    <h2 id="verdict">Phase 2 gate</h2>
    <p class:pass={liftPasses}>
      {liftPasses ? 'Pass' : 'Not yet'}: picks beat review scores alone by at least {GATE_LIFT} in every mode.
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
      {#if mode.results}
        <table>
          <thead>
            <tr><th></th><th>Recommender</th><th>Scores alone</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">Liked titles in top 10</th><td>{fixed(mode.results.model.precision)}</td><td>{fixed(mode.results.baseline.precision)}</td></tr>
            <tr><th scope="row">Share of liked titles found</th><td>{fixed(mode.results.model.recall)}</td><td>{fixed(mode.results.baseline.recall)}</td></tr>
          </tbody>
        </table>
        <p class="lift" class:pass={mode.lift != null && mode.lift >= GATE_LIFT}>Lift {signed(mode.lift ?? 0)}</p>
        <p class="small muted">
          From {mode.rated} rated titles: {mode.testSize} hidden each time, about {mode.relevant.toFixed(1)} of them liked
          (rated {mode.likedPoint} or more), among {mode.poolSample} unseen candidates.
        </p>
        <p class="small muted">
          Parts on their own: content {fixed(mode.results.content.precision)}, collaborative {fixed(mode.results.collaborative.precision)};
          recommender with missing collaborative evidence counted as zero {fixed(mode.results.cfZero.precision)}.
        </p>
      {:else}
        <p class="muted">
          Not enough to check yet: {mode.rated} rated titles with details and {mode.poolSample} candidates. It needs 25 of the
          first and some of the second.
        </p>
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
    font-size: 0.9rem;
  }
  th,
  td {
    padding: 0.35rem 0.25rem;
    text-align: right;
    border-bottom: 1px solid var(--line);
  }
  th[scope='row'],
  thead th:first-child {
    text-align: left;
    font-weight: 500;
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
    margin: 0.3rem 0;
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
