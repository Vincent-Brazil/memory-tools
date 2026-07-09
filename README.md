# memory-tools

Small tools that read/write [`Vincent-Brazil/memory`](https://github.com/Vincent-Brazil/memory) from
mobile and desktop. First tool: **Capture** — a quick-idea form. A Notion-style markdown viewer is
planned as a second app in this repo (see `memory/ideas/memory-md-viewer.md`).

## Capture

A static PWA, no backend. It writes directly to `memory`'s `inbox/` via the GitHub Contents API,
called from the browser. Deployed to GitHub Pages on every push to `main`.

- **URL**: `https://vincent-brazil.github.io/memory-tools/`
- **First run**: paste a GitHub token when prompted. It's stored only in that browser's `localStorage`
  — never committed, never sent anywhere but `api.github.com`.
- **Token**: a fine-grained PAT scoped to `Vincent-Brazil/memory`, **Contents: Read and write** only.
  Create one at GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
  One token per device; disconnect a device with the settings (gear) icon to clear it.
- **Install**: open the URL on mobile → browser menu → Add to Home Screen. On desktop Chrome/Edge →
  address bar install icon → Install. Same static build serves both.
- **Entry format**: writes `inbox/YYYY-MM-DD-<slug>.md` with:
  ```
  ---
  type: idea | task | link
  captured: <ISO timestamp>
  source: mobile-capture
  ---

  <captured text>
  ```
  These land unprocessed — a later review session in the memory repo promotes or bins them, per the
  existing `inbox/` funnel convention.

## Local dev

```
npm install
npm run dev      # local dev server
npm run build    # production build to dist/
```

Icon source is `assets/icon.svg`; regenerate PNGs into `public/icons/` if it changes (192, 512, and
a 180×180 `apple-touch-icon.png`).
