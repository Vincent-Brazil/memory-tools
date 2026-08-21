// The Railway half of memory-tools: serves the built static apps, and holds the
// one secret the browser must not.
//
// Why this exists at all, given the app was deliberately backend-free: an
// OpenRouter key in localStorage would have to be pasted on every device, and
// the device that matters most is a phone. So the model call moved server-side
// and nothing else did. Capture and Viewer still talk to GitHub directly with
// the per-device PAT, exactly as before.
//
// Modelled on `me`'s server.js, which already solved this shape on Railway.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { route } from 'toolbelt-llm-router';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');
const PORT = process.env.PORT || 3000;

// The private repo whose readability proves the caller is Tom. Pinned here, NOT
// taken from the request: a caller-supplied repo would let anyone authenticate
// against a public repo of their own and spend the key.
const BRAIN_REPO = process.env.BRAIN_REPO || 'Vincent-Brazil/brain';

const MODEL_TAG = 'memory-viewer';
// DeepSeek first, matching `me` rather than the cost-first order paper-trader
// uses: a wrong answer about your own memory is worse than a fractionally
// dearer one, and OpenRouter's free tier picks whatever model is free today.
const PROVIDERS = ['deepseek', 'openrouter'];

const MAX_CONTEXT_CHARS = 120_000;
const AUTH_CACHE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Local development: bridge .secrets into the environment
// ---------------------------------------------------------------------------

// The Python router reads env then `.secrets/<name>.txt`; the JS twin reads env
// only. Rather than edit shared code that Clive and paper-trader also run, close
// the gap here. On Railway the variables are always set, so this never runs.
function loadSecretIntoEnv(name, envVar) {
  if (process.env[envVar]) return;
  let dir = HERE;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, '.secrets', `${name}.txt`);
    if (existsSync(candidate)) {
      const value = readFileSync(candidate, 'utf8').replace(/^﻿/, '').trim();
      if (value) {
        process.env[envVar] = value;
        console.log(`[dev] ${envVar} loaded from ${candidate}`);
      }
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return;
    dir = parent;
  }
}

loadSecretIntoEnv('openrouter_api_key', 'OPENROUTER_API_KEY');
loadSecretIntoEnv('deepseek_api_key', 'DEEPSEEK_API_KEY');

// ---------------------------------------------------------------------------
// Auth: can this token read the private brain repo?
// ---------------------------------------------------------------------------

const authCache = new Map();

function fingerprint(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function tokenCanReadBrain(token) {
  const key = fingerprint(token);
  const cached = authCache.get(key);
  if (cached && cached > Date.now()) return true;

  const res = await fetch(`https://api.github.com/repos/${BRAIN_REPO}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'memory-tools-server',
    },
  });
  if (!res.ok) return false;
  authCache.set(key, Date.now() + AUTH_CACHE_MS);
  return true;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// CSP is off deliberately, not by oversight: view/index.html runs an inline
// script to set the theme before first paint (avoiding a flash of the wrong
// one), and both pages load Google Fonts. A default CSP breaks both. Worth
// doing properly with a nonce later; shipping a policy that breaks the app
// would be worse than shipping none.
app.use(helmet({ contentSecurityPolicy: false }));

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    // Names only, never values -- same rule as railway-info.
    providers: PROVIDERS.filter((p) => process.env[p === 'openrouter' ? 'OPENROUTER_API_KEY' : 'DEEPSEEK_API_KEY']),
  });
});

app.post(
  '/api/ask',
  // Per-IP, and low: this endpoint spends money, which no other route here does.
  rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }),
  express.json({ limit: '256kb' }),
  async (req, res) => {
    const token = req.get('x-github-token');
    if (!token) return res.status(401).json({ error: 'Missing GitHub token.' });

    const { question, context } = req.body ?? {};
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'No question.' });
    }
    if (typeof context !== 'string' || context.length > MAX_CONTEXT_CHARS) {
      return res.status(400).json({ error: 'Missing or oversized grounding context.' });
    }

    try {
      if (!(await tokenCanReadBrain(token))) {
        return res.status(403).json({ error: 'That GitHub token cannot read the memory repo.' });
      }
    } catch {
      return res.status(503).json({ error: 'Could not reach GitHub to check the token.' });
    }

    try {
      // `domain: 'personal'` is asserted, not derived. The trust boundary is the
      // browser: it screens each file against the work-content patterns and
      // never puts work material in `context`. The server cannot re-screen
      // without either receiving the content it is meant to exclude, or keeping
      // a second copy of the pattern list -- and duplicated pattern lists are
      // exactly what went wrong with review.py. Set WORK_CONTENT_PATTERNS to add
      // a server-side backstop if that trade ever stops being acceptable.
      const backstop = serverSideWorkScreen(context);
      if (backstop) {
        return res.status(422).json({ error: `Refused: the context matched ${backstop}.` });
      }

      const result = await route({
        prompt: `${context}\n\nQuestion: ${question}`,
        domain: 'personal',
        tag: MODEL_TAG,
        providers: PROVIDERS,
      });
      res.json({ answer: result.text, provider: result.provider ?? null });
    } catch (err) {
      console.error('[ask]', err?.message ?? err);
      res.status(502).json({ error: err?.message || 'No provider could answer.' });
    }
  }
);

/** Optional, off unless WORK_CONTENT_PATTERNS is set: a JSON array of regex
 * source strings. Deliberately not defaulted, so this public repo never carries
 * work identifiers. */
const WORK_PATTERNS = (() => {
  const raw = process.env.WORK_CONTENT_PATTERNS;
  if (!raw) return [];
  try {
    return JSON.parse(raw).map((source) => new RegExp(source, 'i'));
  } catch {
    console.error('[config] WORK_CONTENT_PATTERNS is not a JSON array of regex strings; ignoring it.');
    return [];
  }
})();

function serverSideWorkScreen(context) {
  const hit = WORK_PATTERNS.find((pattern) => pattern.test(context));
  return hit ? `a configured work-content pattern` : null;
}

// Vite content-hashes everything under assets/, so those can be cached forever
// and revalidated never. The HTML, the manifest and the service worker must not
// be: they keep stable names, so a cached copy of one pins an installed PWA to
// asset filenames that no longer exist after a deploy. These headers are also
// what makes Railway's edge CDN safe to switch on — a CDN that honours them
// caches the hashed assets and leaves the entry points alone.
const NEVER_CACHE = /(\.html|\.webmanifest|sw\.js|registerSW\.js)$/;

app.use(
  express.static(DIST, {
    setHeaders: (res, filePath) => {
      if (NEVER_CACHE.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes('assets')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

app.listen(PORT, () => {
  console.log(`memory-tools listening on ${PORT}, serving ${DIST}`);
});
