import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves this from `/memory-tools/`, Railway from `/`. One variable
// keeps a single config honest for both, so the two hosts can run in parallel
// during the move to Railway instead of needing a cutover with Capture down: the
// Pages workflow sets VITE_BASE, Railway sets nothing.
//
// Deliberately not a relative base (`./`), which looks like it would suit both:
// vite-plugin-pwa then emits `./manifest.webmanifest` into `view/index.html`,
// where it resolves to `/view/manifest.webmanifest` and 404s.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        view: resolve(__dirname, 'view/index.html'),
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Memory Capture',
        short_name: 'Capture',
        description: "Quick idea capture into Tom's memory inbox",
        theme_color: '#111111',
        background_color: '#111111',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        share_target: {
          action: base,
          method: 'GET',
          enctype: 'application/x-www-form-urlencoded',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
          },
        },
      },
    }),
  ],
});
