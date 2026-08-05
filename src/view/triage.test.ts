import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueue, parseFrontmatter, renderReview } from './triage';

const baseItem = {
    path: 'inbox/example.md',
    captured: '2026-08-04T12:00:00Z',
    original: 'An original capture',
    proposal: null,
    attempts: 0,
    error: '',
    feedback: '',
    approvedOutcome: '',
    approvedTarget: '',
};

test('discarded captures appear as parked and are restorable', () => {
    const html = renderReview([{ ...baseItem, status: 'discarded' }]);

    assert.match(html, /0 to review/);
    assert.match(html, /Skipped or discarded \(1\)/);
    assert.match(html, /Discarded\. The original capture is retained/);
    assert.match(html, /Restore capture/);
    assert.doesNotMatch(html, /Needs attention/);
});

test('raw backlog uses provider-neutral processing controls', () => {
    const html = renderReview([
        { ...baseItem, path: 'inbox/one.md', status: 'captured' },
        { ...baseItem, path: 'inbox/two.md', status: 'captured' },
    ]);

    assert.match(html, /0 to review/);
    assert.match(html, /2 to process/);
    assert.match(html, /0 blocked/);
    assert.match(html, /2 raw captures are still waiting to be processed/);
    assert.match(html, /To process \(2\)/);
    assert.match(html, /Process next five/);
    assert.match(html, /Process this item/);
    assert.match(html, /How Inbox review works/);
    assert.match(html, /approval records that decision but does not carry it out/);
    assert.doesNotMatch(html, /DeepSeek|Shape inbox/);
});

test('the current proposal shows queue position rather than an ambiguous ready count', () => {
    const proposal = {
        schema_version: 2 as const,
        kind: 'idea' as const,
        title: 'A shaped idea',
        summary: 'A summary',
        why_it_matters: '',
        grounding: '',
        viability: '',
        approach: '',
        definition_of_done: '',
        next_step: '',
        biggest_unknown: '',
        clarifying_question: '',
        executor: 'none' as const,
        outcome: 'save_idea' as const,
        outcome_label: 'Save idea',
        target: '',
        approval_effect: 'If approved, this will save the idea.',
        evidence: [],
        related: [],
    };
    const html = renderReview([
        { ...baseItem, path: 'inbox/one.md', status: 'ready', proposal },
        { ...baseItem, path: 'inbox/two.md', status: 'ready', proposal },
    ]);

    assert.match(html, /1 of 2 to review/);
    assert.match(html, /Your capture/);
    assert.match(html, /Processed proposal/);
    assert.match(html, /Supporting analysis/);
    assert.doesNotMatch(html, />2 ready</);
});

test('save idea approval says it records intent without filing the idea yet', () => {
    const proposal = {
        schema_version: 2 as const,
        kind: 'idea' as const,
        title: 'A shaped idea',
        summary: 'A summary',
        why_it_matters: '',
        grounding: '',
        viability: '',
        approach: '',
        definition_of_done: '',
        next_step: '',
        biggest_unknown: '',
        clarifying_question: '',
        executor: 'none' as const,
        outcome: 'save_idea' as const,
        outcome_label: 'Save as idea',
        target: 'ideas/',
        approval_effect: 'If approved, this will save the shaped idea.',
        evidence: [],
        related: [],
    };
    const html = renderReview([{ ...baseItem, status: 'ready', proposal }]);

    assert.match(html, /Approve for filing as idea/);
    assert.match(html, /does not create or move the idea entry yet/);
    assert.match(html, /Approved, awaiting follow-through/);
    assert.doesNotMatch(html, /Approve: Save as idea/);
});

test('approved ideas stay visibly queued until an executor files them', () => {
    const html = renderReview([
        {
            ...baseItem,
            status: 'approved',
            approvedOutcome: 'save_idea',
            approvedTarget: 'ideas/',
            proposal: {
                schema_version: 2 as const,
                kind: 'idea' as const,
                title: 'A shaped idea',
                summary: 'A summary',
                why_it_matters: '',
                grounding: '',
                viability: '',
                approach: '',
                definition_of_done: '',
                next_step: '',
                biggest_unknown: '',
                clarifying_question: '',
                executor: 'none' as const,
                outcome: 'save_idea' as const,
                outcome_label: 'Save as idea',
                target: 'ideas/',
                approval_effect: 'If approved, this will save the shaped idea.',
                evidence: [],
                related: [],
            },
        },
    ]);

    assert.match(html, /Approved, awaiting follow-through \(1\)/);
    assert.match(html, /data-review-target="approved-items">1 approved/);
    assert.doesNotMatch(html, /href="#approved-items"/);
    assert.match(html, /<details class="review-awaiting-group" id="approved-items">/);
    assert.match(html, /not filed, handed off, or finished/);
    assert.match(html, /Nothing has been filed or handed off yet/);
    assert.match(html, /Open full proposal/);
    assert.match(html, /Undo approval/);
});

test('parked captures have an obvious in-page shortcut instead of appearing missing', () => {
    const html = renderReview([{ ...baseItem, status: 'discarded' }]);

    assert.match(html, /data-review-target="parked-items">1 parked/);
    assert.match(html, /id="parked-items"/);
    assert.match(html, /These captures are retained, not deleted/);
});

test('processing metadata parses without depending on provider terminology', () => {
    const { meta, body } = parseFrontmatter('---\nstatus: ready\nprocessed_by: hosted:cheap-model\n---\n\nRaw capture');

    assert.equal(meta.status, 'ready');
    assert.equal(meta.processed_by, 'hosted:cheap-model');
    assert.equal(body.trim(), 'Raw capture');
});

test('a stale deleted path is ignored instead of becoming needs attention', async () => {
    const result = await buildQueue('token', ['inbox/deleted.md'], async (_pat, path) => {
        throw new Error(`Not found in memory: ${path}`);
    });

    assert.deepEqual(result.items, []);
    assert.deepEqual(result.missingPaths, ['inbox/deleted.md']);
});