// How the assistant learns what this memory *is*, without that knowledge being
// written into this repo.
//
// The brain documents itself: the label conventions, the folder meanings, the
// placement rules, the operating notes. Copying any of that into a system prompt
// here would go stale the moment the brain changed, and the brain changes more
// often than this app does. So the prompt is assembled at runtime from the
// brain's own files.
//
// Discovery is by basename, not path, and every entry is optional. A file that
// moves is still found; a file that is deleted just makes the guide smaller. That
// is the intended failure mode — degrade, never mislead.
//
// It deliberately does not lean on index.md as a table of contents. Navigation is
// retrieval plus the graph; index.md is read here only as one more description of
// how the place works, because a hand-maintained index falls behind the content
// it indexes.

import { workContentReason, type WorkPattern } from './workScreen';
import type { RetrievalCorpus } from './retrieval';

/** Basenames, lowercased and without extension, that tend to describe the memory
 * rather than being memory. Order is priority when the budget runs out. */
const GUIDE_BASENAMES = ['index', 'architecture', 'operating', 'conventions', 'preferences', 'readme'];

const PER_FILE_CHARS = 1200;
const TOTAL_CHARS = 5000;

export interface BrainGuide {
  text: string;
  /** Which files it was built from, so the panel can show what it is going on. */
  sources: string[];
}

function basenameOf(id: string): string {
  return (id.split('/').pop() ?? id).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
}

export function buildBrainGuide(corpus: RetrievalCorpus, workPatterns: WorkPattern[]): BrainGuide {
  const byPriority: { id: string; rank: number }[] = [];
  for (const node of corpus.nodes) {
    const rank = GUIDE_BASENAMES.indexOf(basenameOf(node.id));
    if (rank === -1) continue;
    byPriority.push({ id: node.id, rank });
  }
  // Shallower paths first within a rank: a root index.md describes the whole
  // memory, one nested three deep describes a corner of it.
  byPriority.sort((a, b) => a.rank - b.rank || a.id.split('/').length - b.id.split('/').length || a.id.localeCompare(b.id));

  const parts: string[] = [];
  const sources: string[] = [];
  let used = 0;
  for (const { id } of byPriority) {
    if (used >= TOTAL_CHARS) break;
    const body = corpus.excerptFor(id);
    if (!body.trim()) continue;
    // The guide goes to a hosted model like anything else, so it is screened
    // like anything else.
    if (workContentReason(id, body, workPatterns)) continue;
    const slice = body.slice(0, Math.min(PER_FILE_CHARS, TOTAL_CHARS - used));
    parts.push(`<describes path="${id}">\n${slice}\n</describes>`);
    sources.push(id);
    used += slice.length;
  }

  return { text: parts.join('\n\n'), sources };
}

/** The instructions, kept deliberately thin: what the model must do with the
 * material, not what the material means. Meaning comes from the guide above. */
export function buildPrompt(options: {
  guide: BrainGuide;
  context: string;
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  withheldCount: number;
}): string {
  const { guide, context, question, history, withheldCount } = options;

  const rules = [
    'You are answering questions about a personal memory repository, from inside the app that browses it.',
    '',
    guide.text
      ? 'HOW THIS MEMORY WORKS — these are the repository\'s own files describing itself. Follow the conventions they state, including any that contradict your assumptions:'
      : 'No self-describing files were available, so infer conventions from the excerpts alone and say when you are guessing.',
    guide.text,
    '',
    'EXCERPTS — selected by keyword match and by following edges in the memory graph, so some will be irrelevant. Ignore those rather than working them in:',
    context,
    withheldCount
      ? `\n${withheldCount} file(s) matched but were withheld as work content. Do not speculate about them.`
      : '',
    '',
    'Rules:',
    '- Answer only from the excerpts. If they do not answer it, say so plainly and name the nearest thing that is there.',
    '- Cite each file you used as its exact path in backticks, like `projects/cockpit.md`. The app turns those into links.',
    '- Excerpts are cut with [...] where paragraphs were skipped. A gap is not an absence.',
    '- Be brief and concrete. No preamble, no restating the question, no offers of further help.',
    '- Do not describe the repository structure back to the user. They wrote it.',
  ];

  const past = history.length
    ? `\nEarlier in this conversation:\n${history.map((t) => `${t.role}: ${t.content}`).join('\n')}\n`
    : '';

  return `${rules.filter(Boolean).join('\n')}\n${past}\nQuestion: ${question}`;
}
