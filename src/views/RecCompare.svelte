<script lang="ts">
  import { localToday } from '../lib/library';
  import {
    counted,
    GATE_DAYS,
    GATE_MODE_REACTIONS,
    GATE_REACTIONS,
    loadComparison,
    net,
    type Comparison,
    type DayRecord,
    type Tally,
  } from '../lib/rec/compare';
  import type { Mode } from '../lib/rec/types';
  import { back } from '../lib/router.svelte';
  import { app } from '../lib/state.svelte';

  /** Picks on screen within 1.5 s of opening the app: the gate's other half. */
  const GATE_MS = 1500;
  const speedPasses = $derived(app.slateShownMs != null && app.slateShownMs < GATE_MS);
  const speedText = $derived(app.slateShownMs != null ? `${Math.round(app.slateShownMs).toLocaleString()} ms` : 'not measured this session');

  let result = $state<Comparison | null>(null);
  let error = $state('');
  let copied = $state('');

  $effect(() => {
    void app.version;
    loadComparison()
      .then((value) => (result = value))
      .catch((reason: unknown) => (error = reason instanceof Error ? reason.message : String(reason)));
  });

  const label = (mode: Mode) => (mode === 'US' ? 'Together' : app.profiles[mode]);
  const signed = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0');
  const day = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });

  const ROWS: { label: string; value: (tally: Tally) => string; note?: string }[] = [
    { label: 'Shown', value: (tally) => String(tally.shown) },
    { label: 'Opened', value: (tally) => String(tally.opened) },
    { label: 'Want to watch', value: (tally) => String(tally.wanted) },
    { label: 'Watched after shown', value: (tally) => String(tally.picked) },
    { label: 'Not interested', value: (tally) => String(tally.notInterested) },
    { label: 'Net', value: (tally) => signed(net(tally)) },
    { label: 'Not tonight', value: (tally) => String(tally.notTonight) },
    { label: 'Seen already', value: (tally) => String(tally.seen) },
  ];

  const reactions = (value: Comparison) => counted(value.total.model) + counted(value.total.reviews);
  const record = (days: DayRecord) => `${days.won} ahead, ${days.lost} behind, ${days.tied} level`;

  function verdictText(value: Comparison): string {
    const model = net(value.total.model);
    const reviews = net(value.total.reviews);
    switch (value.verdict) {
      case 'early':
        return value.since == null
          ? 'Not started: no mixed picks seen yet. Open For you to begin.'
          : `Too early: day ${value.days} of ${GATE_DAYS}, ${reactions(value)} of ${GATE_REACTIONS} reactions.`;
      case 'ahead':
        return `Pass: the recommender's picks are ahead, net ${signed(model)} against ${signed(reviews)} for review scores alone.`;
      case 'behind':
        return `Not yet: review scores alone are ahead, net ${signed(reviews)} against ${signed(model)} for the recommender.`;
      case 'even':
        return model === reviews
          ? `Not yet: level at net ${signed(model)} each.`
          : `Not yet: ahead overall (net ${signed(model)} against ${signed(reviews)}) but behind in a mode with ${GATE_MODE_REACTIONS} or more reactions.`;
    }
  }

  const line = (name: string, tally: Tally) =>
    `${name} shown ${tally.shown}, opened ${tally.opened}, want ${tally.wanted}, watched ${tally.picked}, not interested ${tally.notInterested}, ` +
    `net ${signed(net(tally))}, not tonight ${tally.notTonight}, seen ${tally.seen}`;

  function resultsText(value: Comparison): string {
    const lines = [
      `Picks compared, ${localToday(new Date())}, version ${__APP_VERSION__}`,
      value.since == null
        ? 'No mixed picks seen yet'
        : `Since ${localToday(new Date(value.since))} (${value.days} days); ${reactions(value)} counted reactions; verdict ${value.verdict}`,
      `Picks under 1.5 s ${speedPasses ? 'pass' : 'not yet'} (${speedText})`,
    ];
    for (const part of [{ name: 'All', ...value.total }, ...value.modes.map((mode) => ({ name: mode.mode as string, ...mode }))]) {
      lines.push(
        `${part.name}: ${line('recommender', part.model)} | ${line('reviews', part.reviews)} | ${line('exploratory', part.explore)}; ` +
          `days ${part.days.won}/${part.days.lost}/${part.days.tied}`,
      );
    }
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
<h1>Picks compared</h1>
<p class="lede">
  Half the ranked picks on For you come from the recommender and half from review scores alone, mixed in an order you don't
  see. This adds up your reactions to each. Want to watch, and watching a pick within 14 days of seeing it, count for the one
  that picked it; Not interested counts against it. Not tonight and Seen it count neither way. Exploratory picks are kept
  apart.
</p>

{#if error}<p class="warn" role="alert">{error}</p>{/if}

{#if result}
  <section aria-labelledby="gate" class="panel verdict">
    <h2 id="gate">Phase 2 gate</h2>
    <p class:pass={result.verdict === 'ahead'}>{verdictText(result)}</p>
    <p class:pass={speedPasses}>
      {speedPasses ? 'Pass' : 'Not yet'}: picks on screen within 1.5 seconds of opening the app ({speedText}).
    </p>
    <p class="small muted">
      The gate is judged after {GATE_DAYS} days and {GATE_REACTIONS} counted reactions: the recommender must be ahead overall,
      and not behind in any mode with {GATE_MODE_REACTIONS} or more.{#if result.since != null}{' '}Mixed picks since
        {day(result.since)}.{/if}
    </p>
  </section>

  {#each [{ name: 'All modes', mode: null, ...result.total }, ...result.modes.map((mode) => ({ name: label(mode.mode), ...mode }))] as part (part.name)}
    <section class="panel" aria-label={part.name}>
      <h2>{part.name}</h2>
      <table>
        <thead>
          <tr><th>Picks</th><th>Recom­mender</th><th>Review scores</th><th>Explor­atory</th></tr>
        </thead>
        <tbody>
          {#each ROWS as row (row.label)}
            <tr class:net={row.label === 'Net'}>
              <th scope="row">{row.label}</th>
              <td>{row.value(part.model)}</td>
              <td>{row.value(part.reviews)}</td>
              <td>{row.value(part.explore)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="small muted">Days the recommender came out: {record(part.days)}.</p>
    </section>
  {/each}

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
  tr.net th,
  tr.net td {
    font-weight: 700;
  }
  .panel p.small {
    margin: 0.5rem 0 0;
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
