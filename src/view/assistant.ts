// The right-hand assistant panel: ask a question, get an answer grounded in what
// this memory actually contains, with every source it used linked.
//
// It knows nothing about how the graph is built, and holds no model key. It takes
// a RetrievalCorpus from the viewer, screens work content out, assembles a
// grounded prompt, and posts it to this app's own /api/ask.

import { marked } from 'marked';
import { buildContextBlock, selectSources, type Retrieval, type RetrievalCorpus } from './retrieval';
import { buildBrainGuide, buildPrompt, type BrainGuide } from './brainGuide';
import { ensureWorkPatterns, WorkScreenUnavailable } from './workScreen';
import { AssistantUnavailable, ask as askServer } from './askServer';

const PANEL_OPEN_KEY = 'memory_tools_assistant_open';
// Two exchanges of follow-up context. Enough for "and what about X?" to work,
// short enough that the grounding for the current question stays dominant.
const HISTORY_TURNS = 4;

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface AssistantState {
  pat: string;
  corpus: () => Promise<RetrievalCorpus>;
  turns: Turn[];
  inFlight: AbortController | null;
  guide: BrainGuide | null;
}

let state: AssistantState | null = null;

export function renderAssistantPanel(): string {
  return `
    <aside id="assistant" class="assistant" hidden aria-label="Ask memory">
      <div class="assistant-header">
        <span class="assistant-title">&gt; ask memory</span>
        <div class="assistant-header-actions">
          <button id="assistant-clear-btn" class="assistant-icon-btn" type="button" title="Clear conversation">&#8635;</button>
          <button id="assistant-close-btn" class="assistant-icon-btn" type="button" title="Close">&times;</button>
        </div>
      </div>
      <div id="assistant-log" class="assistant-log"></div>
      <form id="assistant-form" class="assistant-form">
        <textarea id="assistant-input" rows="2" placeholder="Ask about anything in memory&hellip;" spellcheck="false"></textarea>
        <div class="assistant-form-actions">
          <button id="assistant-send" type="submit">ask</button>
          <button id="assistant-stop" type="button" class="assistant-danger-btn" hidden>stop</button>
        </div>
      </form>
    </aside>
  `;
}

export function mountAssistant(pat: string, corpus: () => Promise<RetrievalCorpus>) {
  state = { pat, corpus, turns: [], inFlight: null, guide: null };

  document.querySelector<HTMLButtonElement>('#assistant-toggle')!.addEventListener('click', () => setPanelOpen(!isPanelOpen()));
  document.querySelector<HTMLButtonElement>('#assistant-close-btn')!.addEventListener('click', () => setPanelOpen(false));
  document.querySelector<HTMLElement>('#assistant-backdrop')!.addEventListener('click', () => setPanelOpen(false));

  document.querySelector<HTMLButtonElement>('#assistant-clear-btn')!.addEventListener('click', () => {
    state!.turns = [];
    logEl().innerHTML = '';
  });
  document.querySelector<HTMLButtonElement>('#assistant-stop')!.addEventListener('click', () => state!.inFlight?.abort());

  const form = document.querySelector<HTMLFormElement>('#assistant-form')!;
  const input = document.querySelector<HTMLTextAreaElement>('#assistant-input')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void ask(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(input.value);
    }
  });

  if (isPanelOpen()) setPanelOpen(true);
}

// ---------------------------------------------------------------------------
// Panel open/closed
// ---------------------------------------------------------------------------

function isPanelOpen(): boolean {
  return localStorage.getItem(PANEL_OPEN_KEY) === '1';
}

function setPanelOpen(open: boolean) {
  localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0');
  document.querySelector<HTMLElement>('#assistant')!.hidden = !open;
  document.querySelector<HTMLElement>('#assistant-backdrop')!.hidden = !open;
  document.body.classList.toggle('assistant-open', open);
  document.querySelector<HTMLButtonElement>('#assistant-toggle')!.setAttribute('aria-pressed', String(open));
  if (open) document.querySelector<HTMLTextAreaElement>('#assistant-input')?.focus();
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

async function ask(rawQuestion: string) {
  const question = rawQuestion.trim();
  if (!question || !state || state.inFlight) return;

  document.querySelector<HTMLTextAreaElement>('#assistant-input')!.value = '';
  appendUserMessage(question);

  const { answerEl, statusEl, sourcesEl } = appendAnswerShell();
  const controller = new AbortController();
  state.inFlight = controller;
  setBusy(true);

  try {
    statusEl.textContent = 'reading memory…';
    const corpus = await state.corpus();

    // Fails closed: with no screen there is no way to know what is safe to send,
    // so nothing is sent.
    const workPatterns = await ensureWorkPatterns(state.pat);
    if (!state.guide) state.guide = buildBrainGuide(corpus, workPatterns);

    statusEl.textContent = 'choosing sources…';
    const retrieval = selectSources(question, corpus, { workPatterns });
    renderSources(sourcesEl, retrieval, state.guide);

    if (!retrieval.sources.length) {
      statusEl.remove();
      answerEl.textContent = retrieval.withheld.length
        ? 'Everything that matched was work content, so nothing was sent. Ask on the work laptop instead.'
        : 'Nothing in memory matched that. Try naming a project, file, or topic.';
      return;
    }

    statusEl.textContent = 'thinking…';
    const prompt = buildPrompt({
      guide: state.guide,
      context: buildContextBlock(retrieval.sources),
      question,
      history: state.turns.slice(-HISTORY_TURNS),
      withheldCount: retrieval.withheld.length,
    });

    const { answer, provider } = await askServer({ prompt, pat: state.pat, signal: controller.signal });

    statusEl.remove();
    renderAnswerMarkdown(answerEl, answer, corpus.nodes.map((n) => n.id));
    if (provider) appendProviderNote(answerEl, provider);
    state.turns.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
  } catch (err) {
    statusEl.remove();
    if (controller.signal.aborted) {
      answerEl.textContent = 'Stopped.';
    } else {
      answerEl.innerHTML = '';
      answerEl.append(errorNode(err));
    }
  } finally {
    state.inFlight = null;
    setBusy(false);
    scrollLogToBottom();
  }
}

function setBusy(busy: boolean) {
  document.querySelector<HTMLButtonElement>('#assistant-send')!.disabled = busy;
  document.querySelector<HTMLButtonElement>('#assistant-stop')!.hidden = !busy;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function logEl(): HTMLElement {
  return document.querySelector<HTMLElement>('#assistant-log')!;
}

function scrollLogToBottom() {
  const log = logEl();
  log.scrollTop = log.scrollHeight;
}

function appendUserMessage(question: string) {
  const el = document.createElement('div');
  el.className = 'assistant-msg assistant-msg-user';
  el.textContent = question; // never parsed as markup
  logEl().append(el);
  scrollLogToBottom();
}

function appendAnswerShell() {
  const wrapper = document.createElement('div');
  wrapper.className = 'assistant-msg assistant-msg-answer';

  const sourcesEl = document.createElement('div');
  sourcesEl.className = 'assistant-sources';
  const statusEl = document.createElement('p');
  statusEl.className = 'assistant-status';
  const answerEl = document.createElement('div');
  answerEl.className = 'assistant-answer doc';

  wrapper.append(sourcesEl, statusEl, answerEl);
  logEl().append(wrapper);
  scrollLogToBottom();
  return { wrapper, sourcesEl, statusEl, answerEl };
}

/** Grounding shown before the answer arrives, so it is obvious what the answer is
 * built on — and obvious when it is built on the wrong thing. This is the whole
 * reason the panel is trustworthy, so it is not tucked away. */
function renderSources(container: HTMLElement, retrieval: Retrieval, guide: BrainGuide) {
  const { sources, withheld } = retrieval;
  const parts: string[] = [];

  if (sources.length) {
    parts.push(`
      <details class="assistant-sources-list" open>
        <summary>${sources.length} source${sources.length === 1 ? '' : 's'}</summary>
        <ul>
          ${sources
            .map(
              (s) =>
                `<li><a href="#/${encodeURIComponent(s.path)}">${escapeHtml(s.path)}</a>` +
                `<span class="assistant-source-via">${s.via === 'link' ? 'via graph' : 'match'}</span></li>`
            )
            .join('')}
        </ul>
      </details>
    `);
  }

  if (withheld.length) {
    parts.push(`
      <details class="assistant-withheld">
        <summary>${withheld.length} withheld — work content</summary>
        <ul>
          ${withheld
            .map(
              (w) =>
                `<li><a href="#/${encodeURIComponent(w.path)}">${escapeHtml(w.path)}</a>` +
                `<span class="assistant-source-via">${escapeHtml(w.reason)}</span></li>`
            )
            .join('')}
        </ul>
        <p class="assistant-note">Not sent. Work content is answered on the work laptop through the local Claude CLI.</p>
      </details>
    `);
  }

  if (guide.sources.length) {
    parts.push(
      `<p class="assistant-note">conventions read from ${guide.sources.map((s) => escapeHtml(s)).join(', ')}</p>`
    );
  }

  container.innerHTML = parts.join('');
}

function renderAnswerMarkdown(answerEl: HTMLElement, answer: string, knownPaths: string[]) {
  answerEl.innerHTML = marked.parse(answer, { async: false }) as string;
  sanitize(answerEl);
  linkifyPaths(answerEl, new Set(knownPaths));
}

function appendProviderNote(answerEl: HTMLElement, provider: string) {
  const note = document.createElement('p');
  note.className = 'assistant-note';
  note.textContent = `answered by ${provider}`;
  answerEl.append(note);
}

/** Model output is third-party content, unlike the repo markdown the viewer
 * renders elsewhere, so strip anything executable before it reaches the DOM. */
function sanitize(container: HTMLElement) {
  container.querySelectorAll('script, style, iframe, object, embed, form, link, meta').forEach((el) => el.remove());
  container.querySelectorAll<HTMLElement>('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if ((name === 'href' || name === 'src') && /^\s*(javascript|data):/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  container.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
}

/** Turn cited paths into viewer links. The prompt asks for backticked paths, so
 * code spans are the reliable case; bare mentions in prose are caught too, since
 * a citation you cannot click is the thing that makes this untrustworthy. */
function linkifyPaths(container: HTMLElement, knownPaths: Set<string>) {
  container.querySelectorAll('code').forEach((code) => {
    const text = code.textContent?.trim() ?? '';
    if (!knownPaths.has(text)) return;
    const link = document.createElement('a');
    link.href = `#/${encodeURIComponent(text)}`;
    link.className = 'assistant-cite';
    link.append(code.cloneNode(true));
    code.replaceWith(link);
  });

  // Any extension, not just .md — code repos are going into the same graph.
  const pathRe = /\b[\w.@/-]+\.[a-z0-9]{1,5}\b/gi;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if ((node.parentElement as HTMLElement | null)?.closest('a, code')) continue;
    textNodes.push(node);
  }

  for (const node of textNodes) {
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of node.data.matchAll(pathRe)) {
      const path = match[0];
      if (!knownPaths.has(path)) continue;
      const start = match.index!;
      if (start > cursor) fragment.append(node.data.slice(cursor, start));
      const link = document.createElement('a');
      link.href = `#/${encodeURIComponent(path)}`;
      link.className = 'assistant-cite';
      link.textContent = path;
      fragment.append(link);
      cursor = start + path.length;
    }
    if (!fragment.childNodes.length) continue;
    if (cursor < node.data.length) fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }
}

function errorNode(err: unknown): HTMLElement {
  const el = document.createElement('p');
  el.className = 'error';
  if (err instanceof WorkScreenUnavailable || err instanceof AssistantUnavailable) {
    el.textContent = err.message;
  } else {
    el.textContent = err instanceof Error ? err.message : 'The assistant could not answer.';
  }
  return el;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}
