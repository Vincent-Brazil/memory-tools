import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueue, parseFrontmatter, renderReview } from './triage';

const baseItem = {
  path: 'inbox/example.md',
  captured: '2026-08-04T12:00:00Z',
  captureHint: '',
  original: 'An original capture',
  proposal: null,
  attempts: 0,
  error: '',
  feedback: '',
  approvedOutcome: '',
  approvedTarget: '',
};

test('discarded captures appear as reviewed and are restorable', () => {
  const html = renderReview([{ ...baseItem, status: 'discarded' }]);

  assert.match(html, /0 active in total/);
  assert.match(html, /Reviewed \(1\)/);
  assert.match(html, /Discarded\. The original capture is retained/);
  assert.match(html, /Restore capture/);
  assert.doesNotMatch(html, /Needs attention/);
});

test('raw backlog count is explicit when nothing is ready', () => {
  const html = renderReview([
    { ...baseItem, path: 'inbox/one.md', status: 'captured' },
    { ...baseItem, path: 'inbox/two.md', status: 'captured' },
  ]);

  assert.match(html, /0 ready now, 2 waiting for DeepSeek/);
  assert.match(html, /2 raw captures are still waiting for DeepSeek/);
  assert.match(html, /The other captures have not been processed yet/);
});

test('shaping metadata parses without exposing legacy terminology', () => {
  const { meta, body } = parseFrontmatter('---\nstatus: ready\nshaped_by: deepseek:deepseek-chat\n---\n\nRaw capture');

  assert.equal(meta.status, 'ready');
  assert.equal(meta.shaped_by, 'deepseek:deepseek-chat');
  assert.equal(body.trim(), 'Raw capture');
});

test('a stale deleted path is ignored instead of becoming needs attention', async () => {
  const result = await buildQueue('token', ['inbox/deleted.md'], async (_pat, path) => {
    throw new Error(`Not found in memory: ${path}`);
  });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.missingPaths, ['inbox/deleted.md']);
});