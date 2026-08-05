import assert from 'node:assert/strict';
import test from 'node:test';
import { configureRepo, deleteFileContent } from './github';

test('permanent deletion resolves the current sha and deletes the exact Inbox path', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    if (calls.length === 1) return new Response(JSON.stringify({ sha: 'capture-sha' }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    configureRepo('Vincent-Brazil', 'memory');
    await deleteFileContent('token', 'inbox/test capture.md', 'delete discarded capture');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(
    String(calls[0].input),
    'https://api.github.com/repos/Vincent-Brazil/memory/contents/inbox%2Ftest%20capture.md?ref=main'
  );
  assert.equal(calls[0].init?.cache, 'no-store');
  assert.equal(calls[1].init?.method, 'DELETE');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    message: 'delete discarded capture',
    sha: 'capture-sha',
    branch: 'main',
  });
});
