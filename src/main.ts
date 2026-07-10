import './style.css';
import './shared/theme.css';
import { createInboxEntry, type CaptureType } from './github';
import { getPat, clearPat, renderSetupScreen, wireSetupForm } from './shared/auth';
import { getTheme, applyTheme } from './shared/theme';
import { renderSettingsWidget, wireSettingsWidget } from './shared/settingsWidget';

applyTheme(getTheme());

const app = document.querySelector<HTMLDivElement>('#app')!;

const DRAFT_KEY = 'memory_tools_draft';
const RECENT_KEY = 'memory_tools_recent';
const RECENT_LIMIT = 5;

interface Draft {
  text: string;
  type: CaptureType;
}

interface RecentCapture {
  type: CaptureType;
  snippet: string;
  capturedAt: string;
  path: string;
}

function saveDraft(draft: Draft) {
  if (draft.text.trim()) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } else {
    localStorage.removeItem(DRAFT_KEY);
  }
}

function loadDraft(): Draft | null {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

function loadRecent(): RecentCapture[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentCapture[];
    // Entries captured before `path` was tracked can't link or sync type
    // edits — drop them rather than show a broken, un-syncable row.
    return list.filter((item) => typeof item.path === 'string' && item.path.length > 0);
  } catch {
    return [];
  }
}

function pushRecent(entry: RecentCapture) {
  const list = [entry, ...loadRecent()].slice(0, RECENT_LIMIT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function renderRecentList(): string {
  const items = loadRecent();
  if (!items.length) return '';
  return items
    .map((item) => {
      const label = `<span class="recent-type">${item.type}</span><span class="recent-snippet">${escapeHtml(item.snippet)}</span>`;
      return item.path
        ? `<li><a class="recent-link" href="view/#/${encodeURIComponent(item.path)}">${label}</a></li>`
        : `<li>${label}</li>`;
    })
    .join('');
}

function render() {
  const pat = getPat();
  if (!pat) {
    app.innerHTML = renderSetupScreen();
    wireSetupForm(render);
    return;
  }
  app.innerHTML = captureView();
  wireEvents(pat);
}

function captureView() {
  return `
    <div class="top-controls">
      <a href="view/" class="ctrl-btn"><span class="ctrl-label">memory &gt;</span></a>
    </div>
    <main class="screen">
      <h1 class="hero-title">&gt; CAPTURE<span class="cursor">_</span></h1>
      <form id="capture-form" class="capture-card">
        <div class="type-toggle" role="radiogroup" aria-label="Type">
          <label><input type="radio" name="type" value="idea" checked /> idea</label>
          <label><input type="radio" name="type" value="task" /> task</label>
          <label><input type="radio" name="type" value="link" /> link</label>
        </div>
        <div class="prompt-box">
          <span class="prompt-arrow">&gt;</span>
          <textarea id="text-input" placeholder="Type your idea, task, or link… (Ctrl/Cmd+Enter to send)" rows="3" required></textarea>
        </div>
        <button type="submit" id="submit-btn"><span id="submit-label">Capture</span> <span class="btn-arrow">&#8629;</span></button>
      </form>
      <p id="status" class="status" hidden></p>
      <details id="recent-wrap" class="recent-wrap">
        <summary class="recent-title">recent</summary>
        <ul id="recent-list" class="recent-list">${renderRecentList()}</ul>
      </details>
    </main>
    <footer class="status-bar">
      <span class="status-path">~/memory/inbox</span>
      ${renderSettingsWidget()}
    </footer>
  `;
}

function looksLikeLinkShare(title?: string, text?: string, url?: string): boolean {
  // Android's dedicated url field is the most reliable signal when it's
  // populated, but plenty of apps (YouTube, Reddit, Twitter/X, ...) only
  // ever fill `text` — sometimes with a URL plus other words around it —
  // so fall back to spotting a URL anywhere in the shared text.
  if (url) return true;
  return /https?:\/\/\S+/i.test([title, text].filter(Boolean).join(' '));
}

function prefillFromShare(): boolean {
  const params = new URLSearchParams(location.search);
  const title = params.get('title')?.trim();
  const text = params.get('text')?.trim();
  const url = params.get('url')?.trim();
  if (!title && !text && !url) return false;

  const combined = [title, text, url].filter(Boolean).join('\n');
  document.querySelector<HTMLTextAreaElement>('#text-input')!.value = combined;
  if (looksLikeLinkShare(title, text, url)) {
    document.querySelector<HTMLInputElement>('input[name="type"][value="link"]')!.checked = true;
  }
  history.replaceState(null, '', location.pathname);
  return true;
}

function restoreDraft() {
  const draft = loadDraft();
  if (!draft) return;
  document.querySelector<HTMLTextAreaElement>('#text-input')!.value = draft.text;
  const typeInput = document.querySelector<HTMLInputElement>(`input[name="type"][value="${draft.type}"]`);
  if (typeInput) typeInput.checked = true;
}

function wireEvents(pat: string) {
  wireSettingsWidget(() => {
    clearPat();
    render();
  });

  if (!prefillFromShare()) restoreDraft();

  const form = document.querySelector<HTMLFormElement>('#capture-form')!;
  const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
  const submitBtn = document.querySelector<HTMLButtonElement>('#submit-btn')!;
  const submitLabel = document.querySelector<HTMLSpanElement>('#submit-label')!;
  const textInput = document.querySelector<HTMLTextAreaElement>('#text-input')!;

  const persistDraft = () => {
    const type = document.querySelector<HTMLInputElement>('input[name="type"]:checked')!.value as CaptureType;
    saveDraft({ text: textInput.value, type });
  };
  textInput.addEventListener('input', persistDraft);
  document.querySelectorAll<HTMLInputElement>('input[name="type"]').forEach((el) => el.addEventListener('change', persistDraft));

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    const type = document.querySelector<HTMLInputElement>('input[name="type"]:checked')!.value as CaptureType;
    if (!text) return;

    submitBtn.disabled = true;
    submitLabel.textContent = 'Capturing…';
    statusEl.hidden = true;

    try {
      const path = await createInboxEntry(pat, text, type);
      statusEl.textContent = 'Captured.';
      statusEl.className = 'status success';
      statusEl.hidden = false;
      pushRecent({ type, snippet: text.length > 80 ? `${text.slice(0, 80)}…` : text, capturedAt: new Date().toISOString(), path });
      document.querySelector('#recent-list')!.innerHTML = renderRecentList();
      form.reset();
      document.querySelector<HTMLInputElement>('input[name="type"][value="idea"]')!.checked = true;
      clearDraft();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : 'Something went wrong.';
      statusEl.className = 'status error';
      statusEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitLabel.textContent = 'Capture';
    }
  });
}

render();
