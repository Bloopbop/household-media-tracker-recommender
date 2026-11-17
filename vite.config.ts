import { env } from 'node:process';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the app under /<repository-name>/. The deploy workflow
// sets BASE_PATH; local development uses the root.
const base = env.BASE_PATH ?? '/';

// The only hosts the app may talk to. This is the browser-enforced version of
// the "enrichment gateway" boundary in the spec.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://image.tmdb.org",
  "connect-src 'self' https://api.themoviedb.org https://image.tmdb.org https://api.tvmaze.com https://www.omdbapi.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

// Applied to production builds only: the dev server needs inline scripts and
// a websocket for hot reload.
function contentSecurityPolicy(): Plugin {
  return {
    name: 'hmtr-content-security-policy',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!-- content-security-policy -->',
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

export default defineConfig({
  base,
  plugins: [
    svelte(),
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Household Media Tracker',
        short_name: 'Media Tracker',
        description: 'A private, local-first tracker and recommender for what the household watches.',
        lang: 'en',
        display: 'standalone',
        start_url: base,
        scope: base,
        theme_color: '#14161a',
        background_color: '#14161a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything the app shell needs offline, including the SQLite engine.
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
});
