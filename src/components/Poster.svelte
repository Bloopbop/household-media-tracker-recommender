<script lang="ts">
  import { posterUrl } from '../lib/gateway/tmdb';

  let {
    path,
    name,
    size = 'w342',
  }: { path: string | null; name: string; size?: 'w92' | 'w185' | 'w342' } = $props();

  let failed = $state(false);
</script>

<div class="poster">
  {#if path && !failed}
    <!-- crossorigin keeps the cached copy readable and small; see gateway/posters.ts -->
    <img
      src={posterUrl(path, size)}
      alt={`Poster for ${name}`}
      crossorigin="anonymous"
      loading="lazy"
      decoding="async"
      onerror={() => (failed = true)}
    />
  {:else}
    <span class="fallback">{name}</span>
  {/if}
</div>

<style>
  .poster {
    position: relative;
    aspect-ratio: 2 / 3;
    overflow: hidden;
    border-radius: var(--radius);
    background: var(--poster-bg);
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 0.5rem;
    text-align: center;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
</style>
