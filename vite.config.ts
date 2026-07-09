import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/memory-tools/',
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
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Memory Capture',
        short_name: 'Capture',
        description: "Quick idea capture into Tom's memory inbox",
        theme_color: '#111111',
        background_color: '#111111',
        display: 'standalone',
        start_url: '/memory-tools/',
        scope: '/memory-tools/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        share_target: {
          action: '/memory-tools/',
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
