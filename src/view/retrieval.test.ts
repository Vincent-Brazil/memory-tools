import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContextBlock,
  excerpt,
  searchableName,
  selectSources,
  type RetrievalCorpus,
} from './retrieval';
import { parseWorkPatterns, workContentReason } from './workScreen';

// The real list lives in the memory repo and is fetched at runtime; these are
// the same shapes, declared locally so the tests do not depend on a network read
// and no work identifiers live in this repo outside this fixture.
// String.raw, not a plain template literal: `\b` in one of those is a backspace
// character, which silently breaks every word-boundary in the fixture.
const REVIEW_PY_FIXTURE = String.raw`
WORK_DOMAIN_PATTERNS = [
    (r"@(?:examplecorp)\.com\b", "a work email address"),
    (r"\b(?:WP|POKER)-\d{2,}\b", "a Jira ticket key"),
    (r"^\s*(?:speakers?|attendees?|transcript)\s*:", "a transcript or meeting-notes marker"),
]
`;
const WORK_PATTERNS = parseWorkPatterns(REVIEW_PY_FIXTURE);

function corpusOf(files: Record<string, string>, links: Record<string, string[]> = {}): RetrievalCorpus {
  return {
    nodes: Object.entries(files).map(([id, text]) => ({ id, name: searchableName(id), text })),
    excerptFor: (id) => files[id] ?? '',
    related: (id) => links[id] ?? [],
  };
}

test('the file a question is about outranks one that merely mentions it', () => {
  const corpus = corpusOf({
    'projects/cockpit.md': 'Cockpit is the local action board. It holds cards and a write lock.',
    'projects/other.md': 'Cockpit cockpit cockpit is mentioned here repeatedly but this file is about invoicing.',
  });

  const { sources } = selectSources('what is the cockpit action board', corpus);

  assert.equal(sources[0].path, 'projects/cockpit.md');
});

test('a graph neighbour is pulled in even when it shares none of the question words', () => {
  const corpus = corpusOf(
    {
      'projects/viewqueue.md': 'ViewQueue schedules YouTube videos by context.',
      'reference/scheduling.md': 'Deferred playback windows and calendar slots.',
      'unrelated.md': 'Nothing to do with any of this.',
    },
    { 'projects/viewqueue.md': ['reference/scheduling.md'] }
  );

  const { sources } = selectSources('viewqueue', corpus);
  const scheduling = sources.find((s) => s.path === 'reference/scheduling.md');

  assert.ok(scheduling, 'the neighbour should be included');
  assert.equal(scheduling.via, 'link');
  assert.equal(sources.find((s) => s.path === 'projects/viewqueue.md')?.via, 'match');
  assert.ok(!sources.some((s) => s.path === 'unrelated.md'));
});

test('a graph neighbour never outranks a direct match', () => {
  const corpus = corpusOf(
    {
      'a.md': 'Railway deployments and services.',
      'b.md': 'Railway variables, redeploys and build logs for services.',
      'neighbour.md': 'Something else entirely.',
    },
    { 'b.md': ['neighbour.md'] }
  );

  const { sources } = selectSources('railway services', corpus);

  assert.equal(sources[sources.length - 1].path, 'neighbour.md');
});

test('work content is withheld from the model and the reason is reported', () => {
  const corpus = corpusOf({
    'log/phase.md': 'The sprint work covered POKER-1234 and its dependencies.',
    'notes/clean.md': 'The sprint work covered ordinary personal planning.',
  });

  const { sources, withheld } = selectSources('what did the sprint work cover', corpus, {
    workPatterns: WORK_PATTERNS,
  });

  assert.deepEqual(
    withheld.map((w) => w.path),
    ['log/phase.md']
  );
  assert.match(withheld[0].reason, /Jira ticket key/);
  assert.ok(!sources.some((s) => s.path === 'log/phase.md'));
});

test('the work screen matches on content, not folder names', () => {
  assert.match(workContentReason('a.md', 'ping someone@examplecorp.com', WORK_PATTERNS)!, /work email/);
  assert.match(workContentReason('a.md', 'blocked by POKER-88', WORK_PATTERNS)!, /Jira ticket key/);
  assert.match(workContentReason('a.md', 'Attendees: Tom, Sam', WORK_PATTERNS)!, /transcript or meeting/);
  assert.equal(workContentReason('work/notes.md', 'Nothing sensitive in here at all.', WORK_PATTERNS), null);
});

test('the pattern list is parsed out of the processor source', () => {
  assert.equal(WORK_PATTERNS.length, 3);
  assert.deepEqual(
    WORK_PATTERNS.map((p) => p.why),
    ['a work email address', 'a Jira ticket key', 'a transcript or meeting-notes marker']
  );
});

test('an unparseable source yields no patterns, so the caller fails closed', () => {
  assert.deepEqual(parseWorkPatterns('nothing resembling the expected block'), []);
  assert.deepEqual(parseWorkPatterns('WORK_DOMAIN_PATTERNS = [\n]'), []);
});

test('with no screen supplied, nothing is withheld - so the caller must supply one', () => {
  const corpus = corpusOf({ 'a.md': 'sprint work covered POKER-88 today' });

  assert.deepEqual(selectSources('sprint work', corpus).withheld, []);
});

test('a question with only stopwords retrieves nothing rather than everything', () => {
  const corpus = corpusOf({ 'a.md': 'Some content.', 'b.md': 'Other content.' });

  assert.deepEqual(selectSources('what is it', corpus), { sources: [], withheld: [] });
});

test('an excerpt keeps the opening and the paragraphs that answer the question', () => {
  const body = [
    '# Cockpit\n\n`[active — summary]`',
    'A paragraph about entirely unrelated invoicing matters.',
    'The write lock blocks board edits while a sync runs.',
  ].join('\n\n');

  const text = excerpt(body, new Set(['write', 'lock']), 400);

  assert.match(text, /# Cockpit/);
  assert.match(text, /write lock blocks board edits/);
  assert.ok(!text.includes('invoicing'), 'the irrelevant paragraph should be dropped');
  assert.match(text, /\[\.\.\.\]/, 'a gap in the document should be marked');
});

test('an excerpt with no keyword hits falls back to reading on from the top', () => {
  const body = '# Title\n\nThe summary paragraph.\n\nMore detail after that.';

  const text = excerpt(body, new Set(['nothingmatcheshere']), 400);

  assert.match(text, /# Title/);
  assert.match(text, /The summary paragraph/);
});

test('an excerpt respects its character budget', () => {
  const body = ['# Title', 'x'.repeat(300), 'y'.repeat(300), 'z'.repeat(300)].join('\n\n');

  assert.ok(excerpt(body, new Set(['x', 'y', 'z']), 400).length <= 420);
});

test('a skill file is named by its folder, not by SKILL.md', () => {
  assert.equal(searchableName('.claude/skills/railway/SKILL.md'), 'railway');
  assert.equal(searchableName('projects/cockpit.md'), 'cockpit');
});

test('the context block states each path so a citation can be linked', () => {
  const block = buildContextBlock([{ path: 'projects/cockpit.md', score: 3, via: 'match', excerpt: 'Body text.' }]);

  assert.match(block, /<file path="projects\/cockpit.md">/);
  assert.match(block, /Body text\./);
});

test('an empty retrieval says so rather than sending an empty block', () => {
  assert.match(buildContextBlock([]), /No files in memory matched/);
});
