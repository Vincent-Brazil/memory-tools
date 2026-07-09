import '../style.css';
import './view.css';
import { marked } from 'marked';
import { fetchMarkdownTree, fetchFileContent, type MarkdownFile } from '../github';
import { getPat, clearPat, renderSetupScreen, wireSetupForm } from '../shared/auth';

const app = document.querySelector<HTMLDivElement>('#app')!;

let files: MarkdownFile[] = [];
// basename (no extension) -> path, for resolving [[wikilink]]-style references
let slugIndex = new Map<string, string>();

function currentPath(): string {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  return hash || 'index.md';
}

function dirOf(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

function resolveRelative(baseDir: string, rel: string): string {
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = baseDir ? baseDir.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

async function boot() {
  const pat = getPat();
  if (!pat) {
    app.innerHTML = renderSetupScreen();
    wireSetupForm(boot);
    return;
  }

  app.innerHTML = shell();
  wireShell(pat);

  try {
    files = await fetchMarkdownTree(pat);
    slugIndex = new Map();
    for (const f of files) {
      const base = f.path.split('/').pop()!.replace(/\.md$/, '');
      if (!slugIndex.has(base)) slugIndex.set(base, f.path);
    }
    renderBrowseList();
  } catch (err) {
    showError(err);
    return;
  }

  await loadPage(pat, currentPath());
  window.addEventListener('hashchange', () => loadPage(pat, currentPath()));
}

function shell(): string {
  return `
    <div class="viewer">
      <header class="topbar">
        <a href="../" class="back-link">&larr; Capture</a>
        <button id="browse-btn" type="button">Browse</button>
        <button id="settings-btn" type="button" aria-label="Disconnect this device">&#9881;</button>
      </header>
      <div id="browse-panel" class="browse-panel" hidden>
        <input id="browse-filter" type="search" placeholder="Filter files…" />
        <ul id="browse-list"></ul>
      </div>
      <p id="breadcrumb" class="breadcrumb"></p>
      <main id="content" class="doc"><p class="hint">Loading…</p></main>
    </div>
  `;
}

function wireShell(pat: string) {
  document.querySelector('#settings-btn')!.addEventListener('click', () => {
    if (confirm('Disconnect this device? You will need to paste the token again.')) {
      clearPat();
      boot();
    }
  });

  const browseBtn = document.querySelector<HTMLButtonElement>('#browse-btn')!;
  const browsePanel = document.querySelector<HTMLDivElement>('#browse-panel')!;
  browseBtn.addEventListener('click', () => {
    browsePanel.hidden = !browsePanel.hidden;
  });

  const filterInput = document.querySelector<HTMLInputElement>('#browse-filter')!;
  filterInput.addEventListener('input', () => renderBrowseList(filterInput.value));

  void pat;
}

function renderBrowseList(filter = '') {
  const list = document.querySelector<HTMLUListElement>('#browse-list');
  if (!list) return;
  const term = filter.trim().toLowerCase();
  const matches = files
    .filter((f) => !term || f.path.toLowerCase().includes(term))
    .sort((a, b) => a.path.localeCompare(b.path));
  list.innerHTML = matches
    .map((f) => `<li><a href="#/${encodeURIComponent(f.path)}">${f.path}</a></li>`)
    .join('');
}

async function loadPage(pat: string, path: string) {
  const content = document.querySelector<HTMLElement>('#content')!;
  const breadcrumb = document.querySelector<HTMLParagraphElement>('#breadcrumb')!;
  breadcrumb.textContent = path;
  content.innerHTML = '<p class="hint">Loading…</p>';
  document.querySelector<HTMLDivElement>('#browse-panel')!.hidden = true;

  try {
    const raw = await fetchFileContent(pat, path);
    const withWikilinks = raw.replace(/\[\[([a-zA-Z0-9\-_]+)\]\]/g, '[$1](wikilink:$1)');
    content.innerHTML = await marked.parse(withWikilinks);
    rewriteLinks(content, dirOf(path));
    window.scrollTo(0, 0);
  } catch (err) {
    showError(err, path);
  }
}

function rewriteLinks(container: HTMLElement, baseDir: string) {
  container.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('wikilink:')) {
      const slug = href.slice('wikilink:'.length);
      const resolved = slugIndex.get(slug);
      if (resolved) {
        a.setAttribute('href', `#/${encodeURIComponent(resolved)}`);
      } else {
        a.replaceWith(document.createTextNode(a.textContent || slug));
      }
      return;
    }
    if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      return;
    }
    if (href.startsWith('#')) return;
    const [pathPart, anchor] = href.split('#');
    if (pathPart.endsWith('.md')) {
      const resolved = resolveRelative(baseDir, pathPart);
      a.setAttribute('href', `#/${encodeURIComponent(resolved)}${anchor ? '#' + anchor : ''}`);
    }
  });
}

function showError(err: unknown, path?: string) {
  const content = document.querySelector<HTMLElement>('#content');
  const message = err instanceof Error ? err.message : 'Something went wrong.';
  if (content) {
    content.innerHTML = `<p class="error">${message}</p>${
      path && path !== 'index.md' ? '<p><a href="#/index.md">&larr; Back to index</a></p>' : ''
    }`;
  }
}

boot();
