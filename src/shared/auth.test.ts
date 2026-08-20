import { test } from 'node:test';
import assert from 'node:assert/strict';

// auth.ts reads localStorage inside its functions, not at import time, so a stub
// installed before the first call is enough. No DOM in this test runner.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { getRepo } = await import('./auth');

const REPO_KEY = 'memory_tools_repo';

test('rewrites a renamed repo and persists the correction', () => {
  store.clear();
  store.set(REPO_KEY, JSON.stringify({ owner: 'Vincent-Brazil', repo: 'memory' }));

  assert.deepEqual(getRepo(), { owner: 'Vincent-Brazil', repo: 'brain' });
  // Persisted, so the rename is corrected once per device rather than on every read.
  assert.deepEqual(JSON.parse(store.get(REPO_KEY)!), { owner: 'Vincent-Brazil', repo: 'brain' });
});

test('leaves a repo that has not been renamed alone', () => {
  store.clear();
  const current = { owner: 'Vincent-Brazil', repo: 'brain' };
  store.set(REPO_KEY, JSON.stringify(current));

  assert.deepEqual(getRepo(), current);
  assert.deepEqual(JSON.parse(store.get(REPO_KEY)!), current);
});

test('does not rewrite a same-named repo under a different owner', () => {
  store.clear();
  const other = { owner: 'someone-else', repo: 'memory' };
  store.set(REPO_KEY, JSON.stringify(other));

  assert.deepEqual(getRepo(), other);
});

test('returns null when nothing is stored, and does not write', () => {
  store.clear();
  assert.equal(getRepo(), null);
  assert.equal(store.has(REPO_KEY), false);
});

test('returns null on malformed JSON rather than throwing', () => {
  store.clear();
  store.set(REPO_KEY, '{not json');
  assert.equal(getRepo(), null);
});
