<script lang="ts">
  import { formatRating } from '../lib/ratings';

  let {
    value = $bindable(null),
    label,
  }: { value: number | null; label: string } = $props();

  const whole = $derived(value == null ? null : Math.floor(value));
  const half = $derived(value != null && !Number.isInteger(value));
  const NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  /** A number sets exactly that rating; "+½" then adds the half. */
  function pick(number: number) {
    value = number;
  }

  function toggleHalf() {
    if (value == null) return;
    value = Number.isInteger(value) ? Math.min(value + 0.5, 10) : Math.floor(value);
  }
</script>

<fieldset class="picker">
  <legend><span>{label}</span> <strong aria-live="polite">{formatRating(value)}</strong></legend>
  <div class="numbers">
    {#each NUMBERS as number (number)}
      <button
        type="button"
        class="chip"
        aria-pressed={whole === number}
        aria-label={`${number}`}
        onclick={() => pick(number)}>{number}</button
      >
    {/each}
  </div>
  <div class="extras">
    <button
      type="button"
      class="chip"
      aria-pressed={half}
      disabled={value == null || value >= 10}
      onclick={toggleHalf}>+½</button
    >
    <button type="button" class="link" disabled={value == null} onclick={() => (value = null)}>No rating</button>
  </div>
</fieldset>

<style>
  .picker {
    margin: 0;
    padding: 0;
    border: none;
  }
  legend {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
    font-size: 0.9rem;
    color: var(--muted);
  }
  legend strong {
    font-size: 1.3rem;
    color: var(--text);
  }
  .numbers {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 0.4rem;
  }
  .numbers .chip {
    border-radius: 0.5rem;
    padding: 0;
  }
  .extras {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.4rem;
  }
</style>
