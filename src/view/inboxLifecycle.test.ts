import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxPageActionFor, inboxReviewHash, inboxReviewItemFromRoute } from './inboxLifecycle';

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

test('a blocked direct item opens Inbox review for a safe retry', () => {
    const action = inboxPageActionFor('inbox/capture.md', 'needs_attention');

    assert.equal(action.type, 'review');
    assert.equal(action.label, 'Open in Inbox review');
});

test('ordinary files and the Inbox readme have no lifecycle action', () => {
    assert.equal(inboxPageActionFor('projects/example.md', 'captured').type, 'none');
    assert.equal(inboxPageActionFor('inbox/README.md', 'captured').type, 'none');
});

test('a direct Inbox item can target its exact proposal in review', () => {
    const path = 'inbox/capture with spaces.md';

    assert.equal(inboxReviewHash(path), '#/triage?item=inbox%2Fcapture%20with%20spaces.md');
    assert.equal(inboxReviewItemFromRoute('triage?item=inbox/capture with spaces.md'), path);
    assert.equal(inboxReviewItemFromRoute('triage?item=projects/example.md'), null);
});
