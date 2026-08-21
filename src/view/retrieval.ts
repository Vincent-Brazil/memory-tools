import { workContentReason, type WorkPattern } from './workScreen';

// Grounding for the assistant panel: which files should be sent to the model,
// and which must never be. Pure functions over a corpus interface, so the graph
// can be rebuilt without touching any of this.

/** What the assistant needs from memory, split by what each thing costs.
 *
 * Retrieval runs in two stages on purpose. Ranking uses `text`, which must be
 * cheap for every node; only the handful of finalists then pay for `excerptFor`.
 * That is what keeps this working after RESTRUCTURE-PLAN §10.1, where Graphify
 * computes a merged `graph.json` and memory-tools renders it — one fetch instead
 * of re-reading every file, across the brain and the code repos together.
 *
 * Today the viewer satisfies both from the same session cache, so the split
 * costs nothing. After Phase 7 `text` comes from the graph node and `excerptFor`
 * fetches one file. Nothing in this module changes either way.
 *
 * Node ids are opaque. Do not infer anything from their shape — no extension, no
 * folder convention, no single-repo assumption. */
export interface RetrievalCorpus {
  nodes: RetrievalNode[];
  /** Full text of one node, for building an excerpt. Only called for finalists. */
  excerptFor(id: string): string;
  /** Nodes adjacent to this one in the graph. The edge source is the viewer's
   * business — wikilinks today, Graphify's merged graph after Phase 7. */
  related(id: string): string[];
}

export interface RetrievalNode {
  id: string;
  /** A human name for the node, used for the naming-the-thing bonus. */
  name: string;
  /** The cheap ranking signal: whatever text is available without a fetch. */
  text: string;
}

// Common words dropped before scoring — deliberately small and blunt (this only
// needs to beat "shares a stopword" as a bar, not do real NLP).
export const STOPWORDS = new Set([
  'the', 'and', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'this', 'that', 'it',
  'as', 'by', 'or', 'be', 'at', 'from', 'not', 'but', 'if', 'so', 'we', 'i', 'you', 'your', 'our', 'can', 'will',
  'would', 'should', 'could', 'has', 'have', 'had', 'do', 'does', 'did', 'than', 'then', 'there', 'their', 'they',
  'them', 'he', 'she', 'his', 'her', 'its', 'my', 'me', 'us', 'also', 'just', 'into', 'over', 'under', 'about',
  'more', 'most', 'some', 'any', 'all', 'each', 'other', 'such', 'only', 'own', 'same', 'no', 'nor', 'too', 'very',
  'one', 'two', 'three', 'new', 'via', 'per', 'out', 'up', 'down', 'off', 'how', 'what', 'when', 'where', 'why',
  'which', 'who', 'whom', 'been', 'being', 'because', 'while', 'after', 'before', 'both', 'once', 'here', 'again',
  // Pure URL-structure artifacts from link captures (github.com/owner/repo)
  // — always present, never topical.
  'github', 'com', 'https', 'http', 'www',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[\[([a-z0-9\-_]+)\]\]/g, ' $1 ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
}

/** Every significant word in a doc with its count. Question retrieval needs the
 * whole distribution, not a top-N signature: a question's words are often rare
 * in the doc that actually answers it, which is exactly why they discriminate. */
export function termFrequencies(body: string): Map<string, number> {
  const freq = new Map<string, number>();
  tokenize(body).forEach((w) => freq.set(w, (freq.get(w) ?? 0) + 1));
  return freq;
}

/** Top N most-frequent significant words in a doc — a cheap content
 * "signature", used by the graph to infer relatedness between files. */
export function extractTerms(body: string, limit = 15): Set<string> {
  return new Set(
    Array.from(termFrequencies(body).entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([w]) => w)
  );
}

function idf(term: string, docFreq: Map<string, number>): number {
  return 1 / Math.log2(2 + (docFreq.get(term) ?? 1));
}

/** Shared *rare* terms count for more than shared common ones (a cheap IDF
 * stand-in) — otherwise words generic to this whole corpus (memory, claude,
 * capture...) would dominate every match with no real signal. */
export function scoreOverlap(
  a: Set<string>,
  b: Set<string>,
  docFreq: Map<string, number>
): { score: number; shared: string[] } {
  const shared: { term: string; weight: number }[] = [];
  a.forEach((term) => {
    if (!b.has(term)) return;
    shared.push({ term, weight: idf(term, docFreq) });
  });
  shared.sort((x, y) => y.weight - x.weight);
  return { score: shared.reduce((sum, s) => sum + s.weight, 0), shared: shared.slice(0, 4).map((s) => s.term) };
}

/** The searchable "name" for a file — for most that is the basename, but every
 * skill file is literally named SKILL.md, so the meaningful name is its folder.
 *
 * Any extension is stripped, not just `.md`: the plan is to graph code repos into
 * the brain too, and `router.ts` should be findable by the word "router". */
export function searchableName(path: string): string {
  const skillMatch = path.match(/^\.claude\/skills\/([^/]+)\//);
  if (skillMatch) return skillMatch[1];
  return path.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '');
}

// ---------------------------------------------------------------------------
// Selecting sources for a question
// ---------------------------------------------------------------------------

export interface RetrievalSource {
  path: string;
  score: number;
  /** How it got here: a direct term match, or pulled in as a graph neighbour of
   * one. Surfaced in the panel so a surprising citation is explainable. */
  via: 'match' | 'link';
  excerpt: string;
}

export interface Retrieval {
  sources: RetrievalSource[];
  /** Files that ranked well enough to send but were held back, with the reason. */
  withheld: { path: string; reason: string }[];
}

export interface SelectOptions {
  /** The work-content screen, read from the memory repo by workScreen.ts. */
  workPatterns?: WorkPattern[];
  /** How many files to send. */
  limit?: number;
  /** How many top matches get their graph neighbours pulled in. */
  seeds?: number;
  /** Characters of excerpt per file. */
  excerptChars?: number;
}

// A neighbour arrives with no term evidence of its own, so it must not outrank a
// real match — but it should beat the long tail of weak ones, which is the whole
// point of consulting the graph.
const LINK_DECAY = 0.4;

// A question naming a file by name is asking about that file, and body frequency
// alone can bury it under some other doc that merely mentions it a lot.
const NAME_HIT_BONUS = 1.5;

export function selectSources(question: string, corpus: RetrievalCorpus, options: SelectOptions = {}): Retrieval {
  const limit = options.limit ?? 8;
  const seeds = options.seeds ?? 3;
  const excerptChars = options.excerptChars ?? 1400;
  const workPatterns = options.workPatterns ?? [];

  const questionTerms = new Set(tokenize(question));
  if (!questionTerms.size) return { sources: [], withheld: [] };

  // Stage one: rank every node on cheap text only. No fetches.
  const freqById = new Map<string, Map<string, number>>();
  const docFreq = new Map<string, number>();
  for (const node of corpus.nodes) {
    const freq = termFrequencies(node.text);
    freqById.set(node.id, freq);
    freq.forEach((_, term) => docFreq.set(term, (docFreq.get(term) ?? 0) + 1));
  }

  const scored = new Map<string, number>();
  for (const node of corpus.nodes) {
    const freq = freqById.get(node.id)!;
    let score = 0;
    questionTerms.forEach((term) => {
      const count = freq.get(term);
      if (count) score += idf(term, docFreq) * (1 + Math.log2(count));
    });
    const nameTokens = new Set(tokenize(`${node.name} ${node.id.replace(/[/.]/g, ' ')}`));
    let nameHits = 0;
    questionTerms.forEach((term) => {
      if (nameTokens.has(term)) nameHits += 1;
    });
    score += nameHits * NAME_HIT_BONUS;
    if (score > 0) scored.set(node.id, score);
  }

  const ranked = Array.from(scored.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const via = new Map<string, 'match' | 'link'>();
  const combined = new Map<string, number>();
  ranked.forEach(([path, score]) => {
    combined.set(path, score);
    via.set(path, 'match');
  });

  // Graph expansion: the file that answers the question may not use its words —
  // it may just be what the best match links to. This is the graph earning its
  // keep rather than being only a picture.
  ranked.slice(0, seeds).forEach(([path, score]) => {
    for (const neighbour of corpus.related(path)) {
      const boosted = score * LINK_DECAY;
      if (boosted <= (combined.get(neighbour) ?? 0)) continue;
      combined.set(neighbour, boosted);
      if (!via.has(neighbour)) via.set(neighbour, 'link');
    }
  });

  const order = Array.from(combined.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // Stage two: only the finalists pay for their full text.
  const sources: RetrievalSource[] = [];
  const withheld: { path: string; reason: string }[] = [];
  for (const [path, score] of order) {
    if (sources.length >= limit) break;
    const body = corpus.excerptFor(path);
    const reason = workContentReason(path, body, workPatterns);
    if (reason) {
      withheld.push({ path, reason });
      continue;
    }
    sources.push({ path, score, via: via.get(path) ?? 'match', excerpt: excerpt(body, questionTerms, excerptChars) });
  }
  return { sources, withheld };
}

/** The parts of a file worth spending context on: always its opening (title and
 * `[active]`-style label, which say what the file *is*), then whichever later
 * paragraphs mention the question's words, in document order so the excerpt
 * still reads as prose. */
export function excerpt(body: string, questionTerms: Set<string>, budget: number): string {
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return '';

  const scoredParas = paragraphs.map((text, index) => {
    const words = new Set(tokenize(text));
    let hits = 0;
    questionTerms.forEach((term) => {
      if (words.has(term)) hits += 1;
    });
    return { text, index, hits };
  });

  const chosen = new Set<number>([0]);
  let used = paragraphs[0].length;
  const byRelevance = scoredParas
    .filter((p) => p.index !== 0 && p.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.index - b.index);
  for (const para of byRelevance) {
    if (used + para.text.length > budget) continue;
    chosen.add(para.index);
    used += para.text.length;
  }
  // Nothing past the opening matched — read on from the top instead, which for
  // these files is the summary.
  if (chosen.size === 1) {
    for (const para of scoredParas.slice(1)) {
      if (used + para.text.length > budget) break;
      chosen.add(para.index);
      used += para.text.length;
    }
  }

  const ordered = Array.from(chosen).sort((a, b) => a - b);
  return ordered
    .map((index, position) => (position > 0 && ordered[position - 1] !== index - 1 ? `[...]\n${paragraphs[index]}` : paragraphs[index]))
    .join('\n\n');
}

/** The grounding block handed to the model. Paths are stated exactly as the
 * viewer routes them, so a cited path is always a working link. */
export function buildContextBlock(sources: RetrievalSource[]): string {
  if (!sources.length) return 'No files in memory matched this question.';
  return sources.map((s) => `<file path="${s.path}">\n${s.excerpt}\n</file>`).join('\n\n');
}
