<script lang="ts">
  import { nav } from '../lib/router.svelte';
</script>

<p class="back"><a {...nav({ name: 'settings' })}>Settings</a></p>
<h1>About</h1>

<p>
  A private tracker and recommender for what the two of you watch. Everything you record stays in this device's
  storage. The app only reads from the services below; it never sends them your ratings, history or names.
</p>

<section aria-labelledby="credits">
  <h2 id="credits">Data credits</h2>
  <div class="panel credit">
    <img
      class="tmdb-logo"
      src="{import.meta.env.BASE_URL}tmdb-logo.svg"
      alt="TMDB"
      width="190"
      height="82"
    />
    <p class="tmdb-notice">
      This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.
    </p>
  </div>
  <ul class="list">
    <li>Title details, posters and search: TMDB.</li>
    <li>Streaming availability: JustWatch, through TMDB.</li>
    <li>IMDb, Rotten Tomatoes and Metacritic scores: OMDb API.</li>
    <li>Episode data (in a later update): <a href="https://www.tvmaze.com" rel="noreferrer">TVmaze</a>, licensed CC BY-SA 4.0.</li>
  </ul>
</section>

<section aria-labelledby="privacy">
  <h2 id="privacy">Privacy</h2>
  <ul class="list">
    <li>Your keys stay on this device and are sent only to the service they belong to.</li>
    <li>Backups are files you save yourself. They never include your keys.</li>
    <li>There is no account, no tracking and no sync unless you turn it on in a later update.</li>
  </ul>
</section>

<style>
  .back {
    margin: -0.5rem 0 0.25rem;
    font-size: 0.9rem;
  }
  h1 {
    margin-bottom: 0.75rem;
  }
  section {
    margin-top: 1.5rem;
  }
  .credit {
    padding: 1rem;
  }
  .tmdb-logo {
    display: block;
    width: 7.5rem;
    height: auto;
    margin-bottom: 0.75rem;
  }
  .tmdb-notice {
    margin: 0;
    font-weight: 600;
  }
  .list {
    margin: 0.75rem 0 0;
    padding-left: 1.2rem;
  }
  .list li {
    margin-bottom: 0.35rem;
  }
</style>
