import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxPageActionFor } from './inboxLifecycle';

test('a direct raw Inbox item can start processing', () => {
  assert.deepEqual(inboxPageActionFor('inbox/capture.md', 'captured'), {
    type: 'process',
    label: 'Process this item',
    description: 'Start a bounded processing run for this raw capture.',
  });
});

test('a direct ready item sends the user to Inbox review', () => {
  assert.equal(inboxPageActionFor('inbox/capture.md', 'ready').type, 'review');
  assert.equal(inboxPageActionFor('inbox/capture.md', 'ready').label, 'Open in Inbox review');
});

test('an approved item cannot be mistaken for completed work', () => {
  const action = inboxPageActionFor('inbox/capture.md', 'approved');

  assert.equal(action.type, 'approved');
  assert.equal(action.label, 'Approved, awaiting follow-through');
  assert.match(action.description, /destination write has not happened/);
});

test('ordinary files and the Inbox readme have no lifecycle action', () => {
  assert.equal(inboxPageActionFor('projects/example.md', 'captured').type, 'none');
  assert.equal(inboxPageActionFor('inbox/README.md', 'captured').type, 'none');
});
