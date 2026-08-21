// The work-content screen, read from the memory repo rather than hardcoded here.
//
// Two reasons it is not just a constant in this file. It would put work email
// domains, internal hostnames and Jira project keys into this repo, which is
// public today. And it would be a second copy of a list that already exists in
// the memory repo's inbox processor — copies of that list drifting is exactly
// what went wrong before.
//
// Fails closed: if the list cannot be read, the assistant refuses to send
// anything rather than sending unscreened content.

import { fetchFileContent } from '../github';

/** The processor that owns the canonical list. Parsed, not imported, because it
 * is Python — but it is one stable, well-delimited literal, and reading it means
 * there is still only one place the patterns are maintained. */
const SOURCE_PATH = 'tools/inbox-review/review.py';
const BLOCK_RE = /WORK_DOMAIN_PATTERNS\s*=\s*\[([\s\S]*?)\n\]/;
// Each entry is `(r"<regex>", "<why>"),` — the regex is a Python raw string, so
// backslashes pass through to JS unchanged.
const ENTRY_RE = /\(\s*r?"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g;

export interface WorkPattern {
  pattern: RegExp;
  why: string;
}

export class WorkScreenUnavailable extends Error {}

let cached: Promise<WorkPattern[]> | null = null;

/** Cached for the session. A stale list is not a risk worth a fetch per
 * question: the file changes about once a quarter. */
export function ensureWorkPatterns(pat: string): Promise<WorkPattern[]> {
  if (!cached) {
    cached = loadWorkPatterns(pat).catch((err) => {
      cached = null; // let the next question retry rather than failing forever
      throw err;
    });
  }
  return cached;
}

async function loadWorkPatterns(pat: string): Promise<WorkPattern[]> {
  let source: string;
  try {
    source = await fetchFileContent(pat, SOURCE_PATH);
  } catch (err) {
    throw new WorkScreenUnavailable(
      `Could not read the work-content screen from ${SOURCE_PATH}, so nothing was sent to the model. ` +
        (err instanceof Error ? err.message : '')
    );
  }
  const patterns = parseWorkPatterns(source);
  if (!patterns.length) {
    throw new WorkScreenUnavailable(
      `Found no work-content patterns in ${SOURCE_PATH}. Refusing to send anything to the model — ` +
        'an empty screen would pass everything.'
    );
  }
  return patterns;
}

/** Exported for tests: the parse is the fragile part, not the fetch. */
export function parseWorkPatterns(source: string): WorkPattern[] {
  const block = source.match(BLOCK_RE)?.[1];
  if (!block) return [];
  const found: WorkPattern[] = [];
  for (const match of block.matchAll(ENTRY_RE)) {
    // Python's re is multiline-capable per-call; the one pattern that relies on
    // it anchors with ^, so carry both flags rather than guessing per entry.
    try {
      found.push({ pattern: new RegExp(match[1], 'im'), why: match[2] });
    } catch {
      // A pattern JS cannot compile is not silently skipped: it would be a
      // hole in the screen. Bail so the caller fails closed.
      return [];
    }
  }
  return found;
}

/** Non-null when this file must not be sent to a hosted model, naming the signal
 * that tripped so the panel can say why rather than silently dropping it. */
export function workContentReason(path: string, body: string, patterns: WorkPattern[]): string | null {
  const haystack = `${path}\n${body}`;
  for (const { pattern, why } of patterns) {
    // Shared RegExp objects with /g would carry lastIndex between calls; these
    // are built without it, so test() is stateless here.
    if (pattern.test(haystack)) return why;
  }
  return null;
}
