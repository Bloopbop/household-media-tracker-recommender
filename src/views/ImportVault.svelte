<script lang="ts">
  import Poster from '../components/Poster.svelte';
  import {
    finishImport,
    importStatus,
    importWithoutMatch,
    listChecks,
    listReviewRows,
    resolveRow,
    runMatching,
    searchAgain,
    setCheckDone,
    skipRow,
    stageBundle,
    type ImportCheck,
    type ImportRow,
    type ImportStatus,
  } from '../lib/importer';
  import { nav } from '../lib/router.svelte';
  import { app } from '../lib/state.svelte';
  import { KIND_LABEL, type SearchResult } from '../lib/types';
  import { parseBundle, type VaultBundle, type VaultCandidateRow } from '../lib/vault';

  let status = $state<ImportStatus | null>(null);
  let rows = $state<ImportRow[]>([]);
  let checks = $state<ImportCheck[]>([]);
  let bundle = $state<VaultBundle | null>(null);
  let fileError = $state('');
  let message = $state('');
  let busy = $state<number | 'all' | null>(null);
  let rowError = $state<Record<number, string>>({});
  let showDone = $state(false);

  $effect(() => {
    void app.version;
    void load();
  });

  async function load() {
    status = await importStatus();
    rows = await listReviewRows();
    checks = await listChecks();
  }

  const progress = $derived(app.importProgress);
  const canMatch = $derived(app.online && app.tmdbKey !== '');
  const active = $derived(status != null && (status.pending > 0 || status.review > 0 || status.imported > 0 || status.skipped > 0));
  const openChecks = $derived(checks.filter((check) => !check.done));
  const doneChecks = $derived(checks.filter((check) => check.done));
  const groups = $derived([
    { label: 'Watched titles', rows: rows.filter((row) => row.rowType === 'library') },
    { label: 'Not interested', rows: rows.filter((row) => row.rowType === 'not_interested') },
    { label: 'Recommendations', rows: rows.filter((row) => row.rowType === 'candidate') },
  ]);

  async function chooseFile(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    bundle = null;
    fileError = '';
    message = '';
    if (!file) return;
    const parsed = parseBundle(await file.text());
    if (parsed.ok) bundle = parsed.bundle;
    else fileError = parsed.error;
  }

  async function startImport() {
    if (!bundle) return;
    const { staged, alreadyHere } = await stageBundle(bundle);
    bundle = null;
    message =
      staged === 0
        ? 'Everything in this file is already in the app.'
        : `${staged} new row${staged === 1 ? '' : 's'} to match${alreadyHere ? `; ${alreadyHere} already in the app were left as they are` : ''}.`;
    await load();
    if (staged > 0) await match();
  }

  async function match() {
    message = '';
    const stopped = await runMatching();
    if (stopped) message = stopped;
    await load();
  }

  async function act(row: ImportRow, action: () => Promise<void>) {
    busy = row.id;
    rowError = { ...rowError, [row.id]: '' };
    try {
      await action();
    } catch (error) {
      rowError = { ...rowError, [row.id]: error instanceof Error ? error.message : String(error) };
    } finally {
      busy = null;
    }
  }

  async function skipAll(list: ImportRow[]) {
    busy = 'all';
    try {
      for (const row of list) await skipRow(row.id);
    } finally {
      busy = null;
    }
  }

  async function finish() {
    await finishImport();
    message = 'Import finished.';
    await load();
  }

  const yearText = (year: number | null) => (year ? ` (${year})` : '');
  const kindText = (row: ImportRow) => ('kind' in row.data && row.data.kind ? KIND_LABEL[row.data.kind] : '');
  const creatorsText = (row: ImportRow) => ('creators' in row.data && row.data.creators.length ? row.data.creators.join(', ') : '');
  const isPoolSeed = (row: ImportRow) => row.rowType === 'candidate' && (row.data as VaultCandidateRow).destination === 'candidate_pool';

  const ADVICE: Record<string, string> = {
    'mentions a rewatch': 'Tick “Would rewatch” on the title page if it applies.',
    'per-season scores in the notes': 'The overall rating was imported. The season scores stay in the note.',
    'title has a qualifier in brackets': 'Check the right version was matched.',
    'film with a range of years': 'This note may cover more than one film. Add the others with Add, and check this match.',
    'film or documentary with a range of years': 'Probably a series. Check it was matched as one.',
  };

  function optionLabel(option: SearchResult): string {
    return `${option.name}${yearText(option.year)} · ${KIND_LABEL[option.kind]}`;
  }
</script>

<p class="back"><a {...nav({ name: 'settings' })}>Settings</a></p>
<h1>Import from the vault</h1>

{#if message}<p class="message" role="status">{message}</p>{/if}

{#if progress}
  <div class="panel pad" aria-live="polite">
    <p>Matching {progress.done} of {progress.total}…</p>
    <progress max={progress.total || 1} value={progress.done}></progress>
    <p class="muted small">You can leave this screen; matching carries on while the app is open. If the app closes, it continues from where it stopped.</p>
  </div>
{:else if status && status.pending > 0}
  <div class="panel pad">
    <p>{status.pending} row{status.pending === 1 ? '' : 's'} still to match.</p>
    <button type="button" disabled={!canMatch} onclick={match}>Continue matching</button>
    {#if !canMatch}<p class="muted small">{app.online ? 'Matching needs a TMDB key.' : 'Matching needs a network connection.'}</p>{/if}
  </div>
{/if}

{#if rows.length > 0}
  <p class="muted small">Choose the right match for each title below, or skip it.</p>
{/if}

{#if status && active}
  <p class="counts">
    <span><strong>{status.imported}</strong> imported</span>
    <span><strong>{status.review}</strong> need you</span>
    {#if status.skipped}<span><strong>{status.skipped}</strong> skipped</span>{/if}
  </p>
{/if}

{#each groups as group (group.label)}
  {#if group.rows.length > 0}
    <section aria-labelledby={`group-${group.label}`}>
      <div class="group-head">
        <h2 id={`group-${group.label}`}>{group.label}</h2>
        {#if group.label !== 'Watched titles' && group.rows.length > 1}
          <button type="button" class="link" disabled={busy !== null} onclick={() => skipAll(group.rows)}>Skip all</button>
        {/if}
      </div>
      <ul class="review">
        {#each group.rows as row (row.id)}
          <li class="panel">
            <p class="vault-title">{row.data.title}{yearText(row.data.year)}</p>
            <p class="muted small">
              {[kindText(row), creatorsText(row)].filter(Boolean).join(' · ')}
            </p>
            <p class="small reason">{row.reason}</p>
            {#if row.options && row.options.length > 0}
              <ul class="options">
                {#each row.options as option (`${option.kind}:${option.tmdbId}`)}
                  <li>
                    <button type="button" class="option" disabled={busy !== null} onclick={() => act(row, () => resolveRow(row.id, option))}>
                      <span class="thumb"><Poster path={option.posterPath} name={option.name} size="w92" /></span>
                      <span>{optionLabel(option)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <button type="button" class="secondary" disabled={busy !== null || !canMatch} onclick={() => act(row, () => searchAgain(row.id))}>
                Search again
              </button>
            {/if}
            <div class="actions">
              {#if !isPoolSeed(row)}
                <button type="button" class="link" disabled={busy !== null} onclick={() => act(row, () => importWithoutMatch(row.id))}>
                  {row.options && row.options.length > 0
                    ? `None of these: ${row.rowType === 'library' ? 'keep it unmatched' : 'keep it by name'}`
                    : row.rowType === 'library'
                      ? 'Keep it unmatched'
                      : 'Keep it by name'}
                </button>
              {/if}
              <button type="button" class="link" disabled={busy !== null} onclick={() => act(row, () => skipRow(row.id))}>Skip it</button>
            </div>
            {#if rowError[row.id]}<p class="small error" role="alert">{rowError[row.id]}</p>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/each}

{#if checks.length > 0}
  <section aria-labelledby="checks">
    <h2 id="checks">To check: {openChecks.length} left</h2>
    <ul class="checks">
      {#each openChecks as check (check.id)}
        <li>
          <label>
            <input type="checkbox" checked={check.done} onchange={(event) => setCheckDone(check.id, (event.currentTarget as HTMLInputElement).checked)} />
            <span>
              <strong>{check.title}</strong>: {check.issue}.
              {#if ADVICE[check.issue]}<span class="muted"> {ADVICE[check.issue]}</span>{/if}
              {#if check.detail && (!ADVICE[check.issue] || check.issue === 'per-season scores in the notes')}
                <span class="detail small muted">{check.detail}</span>
              {/if}
            </span>
          </label>
          {#if check.titleId}<a class="small" {...nav({ name: 'title', id: check.titleId })}>Open</a>{/if}
        </li>
      {/each}
    </ul>
    {#if doneChecks.length > 0}
      <button type="button" class="link" onclick={() => (showDone = !showDone)}>
        {showDone ? 'Hide' : 'Show'} {doneChecks.length} done
      </button>
      {#if showDone}
        <ul class="checks done">
          {#each doneChecks as check (check.id)}
            <li>
              <label>
                <input type="checkbox" checked onchange={(event) => setCheckDone(check.id, (event.currentTarget as HTMLInputElement).checked)} />
                <span><strong>{check.title}</strong>: {check.issue}.</span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
{/if}

{#if status && status.pending === 0 && status.review === 0 && (status.imported > 0 || status.skipped > 0) && !progress}
  <div class="panel pad">
    <p>Every row is imported or skipped.{openChecks.length > 0 ? ' Work through the checklist when you can.' : ''}</p>
    <button type="button" onclick={finish}>Finish import</button>
  </div>
{/if}

{#if status && status.pending === 0 && !progress}
  <section aria-labelledby="file">
    <h2 id="file">{active ? 'Import another file' : 'Choose the file'}</h2>
    <div class="panel pad">
      {#if !active}
        <p class="small">
          Choose <strong>vault-import.json</strong>, made by the converter from your Obsidian vault. Matching each title takes
          a minute or two and needs a network connection. Anything already in the app is kept as it is.
        </p>
      {/if}
      <input type="file" accept=".json,application/json" onchange={chooseFile} />
      {#if fileError}<p class="small error" role="alert">{fileError}</p>{/if}
      {#if bundle}
        <p class="small">
          {bundle.vault ? `From “${bundle.vault}”` : 'From the vault'}{bundle.generatedAt
            ? `, made ${new Date(bundle.generatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
            : ''}: {bundle.library.length} watched titles, {bundle.notInterested.length} not interested, {bundle.candidates.length}
          recommendations, and {bundle.checks.length} things to check afterwards.
        </p>
        <button type="button" disabled={!canMatch} onclick={startImport}>Import</button>
        {#if !canMatch}
          <p class="muted small">
            {app.online ? 'Importing needs a TMDB key.' : 'Importing needs a network connection.'}
            {#if !app.tmdbKey}<a {...nav({ name: 'settings' })}>Add a key in Settings</a>.{/if}
          </p>
        {/if}
      {/if}
    </div>
  </section>
{/if}

<style>
  .back {
    margin: -0.5rem 0 0.25rem;
    font-size: 0.9rem;
  }
  h1 {
    margin-bottom: 1rem;
  }
  section {
    margin-top: 1.5rem;
  }
  .pad {
    display: grid;
    gap: 0.6rem;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  .pad p {
    margin: 0;
  }
  progress {
    width: 100%;
  }
  .message {
    padding: 0.6rem 0.9rem;
    border-left: 3px solid var(--accent);
    background: var(--panel);
  }
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .group-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .review,
  .options,
  .checks {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .review > li {
    display: grid;
    gap: 0.4rem;
    margin-bottom: 0.75rem;
    padding: 0.9rem;
  }
  .review p {
    margin: 0;
  }
  .vault-title {
    font-weight: 600;
  }
  .reason {
    color: var(--warn);
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.35rem 0;
    border: none;
    border-top: 1px solid var(--line);
    border-radius: 0;
    background: none;
    color: inherit;
    font-weight: 400;
    text-align: left;
    justify-content: flex-start;
  }
  .thumb {
    display: block;
    flex: 0 0 2.25rem;
    width: 2.25rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
  }
  .checks li {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--line);
  }
  .checks label {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
  }
  .checks input {
    flex: 0 0 auto;
    width: 1.35rem;
    min-height: 1.35rem;
    height: 1.35rem;
    margin-top: 0.1rem;
  }
  .detail {
    display: block;
    margin-top: 0.15rem;
  }
  .done {
    opacity: 0.7;
  }
  .error {
    color: var(--bad);
  }
</style>
