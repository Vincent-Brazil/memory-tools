import '../style.css';
import '../shared/theme.css';
import './view.css';
import { marked } from 'marked';
import {
  fetchMarkdownTree,
  fetchFileContent,
  fetchLastCommitDate,
  githubEditUrl,
  deleteInboxFile,
  updateFileContent,
  type MarkdownFile,
} from '../github';
import { getPat, clearPat, renderSetupScreen, wireSetupForm } from '../shared/auth';
import { getTheme, applyTheme } from '../shared/theme';
import { renderSettingsWidget, wireSettingsWidget } from '../shared/settingsWidget';

applyTheme(getTheme());

const app = document.querySelector<HTMLDivElement>('#app')!;
const MOBILE_BREAKPOINT = 860;
const RECENT_PAGES_KEY = 'memory_tools_recent_pages';
const RECENT_PAGES_LIMIT = 5;
const CONTENT_SEARCH_MIN_LENGTH = 3;
const CONTENT_SEARCH_CONCURRENCY = 6;

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  children: TreeNode[];
}

let slugIndex = new Map<string, string>();
const contentCache = new Map<string, string>();
let searchGeneration = 0;
let navOrder: string[] = [];
const INBOX_TYPES = ['idea', 'task', 'link'];
const SWIPE_THRESHOLD = 60;

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

async function getFileContent(pat: string, path: string): Promise<string> {
  const cached = contentCache.get(path);
  if (cached !== undefined) return cached;
  const raw = await fetchFileContent(pat, path);
  contentCache.set(path, raw);
  return raw;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: raw };
  const block = raw.slice(4, end);
  const bodyStart = raw.indexOf('\n', end + 1);
  const body = bodyStart === -1 ? '' : raw.slice(bodyStart + 1);
  const meta: Record<string, string> = {};
  block.split('\n').forEach((line) => {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  });
  return { meta, body };
}

function renderMetaBar(meta: Record<string, string>, path: string): string {
  if (!Object.keys(meta).length) return '';
  const isInbox = path.startsWith('inbox/');
  const fields: string[] = [];

  if (meta.type) {
    fields.push(
      isInbox
        ? `<label class="meta-field">type <select id="type-select" class="type-select">${INBOX_TYPES.map(
            (t) => `<option value="${t}"${t === meta.type ? ' selected' : ''}>${t}</option>`
          ).join('')}</select></label>`
        : `<span class="meta-field">type <span class="meta-value">${meta.type}</span></span>`
    );
  }
  if (meta.captured) {
    fields.push(`<span class="meta-field">captured <span class="meta-value">${formatDateTime(meta.captured)}</span></span>`);
  }
  if (meta.source) {
    fields.push(`<span class="meta-field">source <span class="meta-value">${meta.source}</span></span>`);
  }
  return fields.length ? `<div class="meta-bar">${fields.join('')}</div>` : '';
}

function flattenNavOrder(root: TreeNode): string[] {
  const order: string[] = [];
  const indexNode = root.children.find((c) => c.isFile && c.path === 'index.md');
  if (indexNode) order.push(indexNode.path);

  const visitFolder = (node: TreeNode) => {
    const subfolders = node.children.filter((c) => !c.isFile).sort((a, b) => a.name.localeCompare(b.name));
    const files = node.children.filter((c) => c.isFile).sort((a, b) => a.name.localeCompare(b.name));
    subfolders.forEach(visitFolder);
    files.forEach((f) => order.push(f.path));
  };
  root.children
    .filter((c) => !c.isFile)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(visitFolder);

  root.children
    .filter((c) => c.isFile && c.path !== 'index.md')
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((f) => order.push(f.path));

  return order;
}

function loadRecentPages(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_PAGES_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function pushRecentPage(path: string) {
  if (path === 'index.md') return;
  const list = [path, ...loadRecentPages().filter((p) => p !== path)].slice(0, RECENT_PAGES_LIMIT);
  localStorage.setItem(RECENT_PAGES_KEY, JSON.stringify(list));
  renderRecentPagesSection();
}

function removeRecentPage(path: string) {
  localStorage.setItem(RECENT_PAGES_KEY, JSON.stringify(loadRecentPages().filter((p) => p !== path)));
  renderRecentPagesSection();
}

function removeFromTree(path: string) {
  document.querySelectorAll<HTMLAnchorElement>(`.tree-item[data-path="${CSS.escape(path)}"]`).forEach((el) => el.remove());
  const base = path.split('/').pop()!.replace(/\.md$/, '');
  if (slugIndex.get(base) === path) slugIndex.delete(base);
}

function renderRecentPagesSection() {
  const el = document.querySelector<HTMLElement>('#recent-pages');
  if (!el) return;
  const paths = loadRecentPages();
  el.innerHTML = paths.length
    ? `<details class="tree-folder tree-recent">
        <summary>recent</summary>
        <div class="tree-folder-content">
          ${paths
            .map((p) => `<a class="tree-item" href="#/${encodeURIComponent(p)}" data-path="${p}" title="${p}">${p.replace(/\.md$/, '')}</a>`)
            .join('')}
        </div>
      </details>`
    : '';
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.isFile === isFile);
      if (!child) {
        child = { name: part, path: acc, isFile, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  sortTree(root);
  return root;
}

function sortTree(node: TreeNode) {
  node.children.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1; // folders before files
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortTree);
}

function renderFileItem(node: TreeNode): string {
  const label = node.name.replace(/\.md$/, '');
  return `<a class="tree-item" href="#/${encodeURIComponent(node.path)}" data-path="${node.path}">${label}</a>`;
}

function renderFolder(node: TreeNode): string {
  const subfolders = node.children.filter((c) => !c.isFile);
  const files = node.children.filter((c) => c.isFile);
  const inner = subfolders.map(renderFolder).join('') + files.map(renderFileItem).join('');
  return `
    <details class="tree-folder" data-folder-path="${node.path}">
      <summary>${node.name}</summary>
      <div class="tree-folder-content">${inner}</div>
    </details>
  `;
}

function renderTree(root: TreeNode): string {
  const indexNode = root.children.find((c) => c.isFile && c.path === 'index.md');
  const otherRootFiles = root.children
    .filter((c) => c.isFile && c.path !== 'index.md')
    .sort((a, b) => a.name.localeCompare(b.name));
  const rootFolders = root.children.filter((c) => !c.isFile).sort((a, b) => a.name.localeCompare(b.name));
  return (
    (indexNode ? `<div class="tree-home">${renderFileItem(indexNode)}</div>` : '') +
    `<div class="tree-folders">${rootFolders.map(renderFolder).join('')}</div>` +
    `<div class="tree-root">${otherRootFiles.map(renderFileItem).join('')}</div>`
  );
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
    const files: MarkdownFile[] = (await fetchMarkdownTree(pat)).filter((f) => !f.path.startsWith('.claude/'));
    slugIndex = new Map();
    for (const f of files) {
      const base = f.path.split('/').pop()!.replace(/\.md$/, '');
      if (!slugIndex.has(base)) slugIndex.set(base, f.path);
    }
    const tree = buildTree(files.map((f) => f.path));
    const treeEl = document.querySelector<HTMLElement>('#tree')!;
    treeEl.innerHTML = renderTree(tree);
    wireFolderAccordion(document.querySelector<HTMLElement>('#sidebar')!);
    navOrder = flattenNavOrder(tree);
  } catch (err) {
    showError(err);
    return;
  }

  wireSwipeNav();
  await loadPage(pat, currentPath());
  window.addEventListener('hashchange', () => loadPage(pat, currentPath()));
}

function shell(): string {
  return `
    <div class="viewer">
      <button id="sidebar-toggle" class="sidebar-toggle-btn" type="button" aria-label="Toggle navigation">&#9776;</button>
      <div class="top-controls">
        <a href="../" class="ctrl-btn" aria-label="Back to Capture">&larr; Capture</a>
      </div>
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">memory</span>
          ${renderSettingsWidget()}
        </div>
        <input id="filter-input" class="sidebar-search" type="search" placeholder="Search…" autocomplete="off" />
        <p id="search-status" class="search-status" hidden></p>
        <div id="recent-pages"></div>
        <nav id="tree" class="tree"><p class="hint">Loading…</p></nav>
      </aside>
      <div id="sidebar-backdrop" class="sidebar-backdrop" hidden></div>
      <div class="content-column">
        <div class="content-meta">
          <p id="breadcrumb" class="breadcrumb"></p>
          <div class="content-meta-right">
            <span id="last-updated" class="last-updated"></span>
            <a id="edit-link" class="edit-link" target="_blank" rel="noopener noreferrer">edit</a>
            <button id="complete-btn" class="complete-btn" type="button" hidden>&#10003; complete</button>
          </div>
        </div>
        <main id="content" class="doc"><p class="hint">Loading…</p></main>
      </div>
    </div>
  `;
}

function navigateRelative(delta: number) {
  const idx = navOrder.indexOf(currentPath());
  if (idx === -1) return;
  const next = idx + delta;
  if (next < 0 || next >= navOrder.length) return;
  location.hash = `#/${encodeURIComponent(navOrder[next])}`;
}

function wireSwipeNav() {
  const content = document.querySelector<HTMLElement>('.content-column')!;
  let startX = 0;
  let startY = 0;
  let tracking = false;

  content.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    },
    { passive: true }
  );

  content.addEventListener(
    'touchend',
    (e) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      navigateRelative(dx < 0 ? -1 : 1);
    },
    { passive: true }
  );
}

function wireShell(pat: string) {
  wireSettingsWidget(() => {
    clearPat();
    boot();
  });

  renderRecentPagesSection();

  document.querySelector<HTMLButtonElement>('#complete-btn')!.addEventListener('click', () => {
    void completeInboxItem(pat, currentPath());
  });

  const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
  const backdrop = document.querySelector<HTMLElement>('#sidebar-backdrop')!;
  const toggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!;

  const openSidebar = () => {
    sidebar.classList.add('open');
    backdrop.hidden = false;
    document.body.classList.add('sidebar-open');
  };
  const closeSidebar = () => {
    sidebar.classList.remove('open');
    backdrop.hidden = true;
    document.body.classList.remove('sidebar-open');
  };
  toggle.addEventListener('click', () => (sidebar.classList.contains('open') ? closeSidebar() : openSidebar()));
  backdrop.addEventListener('click', closeSidebar);
  sidebar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tree-item') && window.innerWidth <= MOBILE_BREAKPOINT) closeSidebar();
  });

  const filterInput = document.querySelector<HTMLInputElement>('#filter-input')!;
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  filterInput.addEventListener('input', () => {
    applyPathFilter(filterInput.value);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void runContentSearch(pat, filterInput.value), 350);
  });
}

function applyPathFilter(term: string) {
  const t = term.trim().toLowerCase();
  document.querySelectorAll<HTMLAnchorElement>('.tree-item').forEach((el) => {
    const path = el.getAttribute('data-path') || '';
    el.classList.toggle('hidden', Boolean(t) && !path.toLowerCase().includes(t));
    el.classList.remove('content-match');
  });
  updateFolderVisibility(Boolean(t));
}

function wireFolderAccordion(container: HTMLElement) {
  // 'toggle' doesn't bubble, so listen in the capture phase on the container.
  // Covers the whole sidebar (real folders + the "recent" drawer), not just #tree.
  container.addEventListener(
    'toggle',
    (e) => {
      const folder = e.target as HTMLDetailsElement;
      if (!folder.classList?.contains('tree-folder') || !folder.open) return;
      const filterTerm = document.querySelector<HTMLInputElement>('#filter-input')?.value.trim();
      if (filterTerm) return; // search may need several folders open at once
      container.querySelectorAll<HTMLDetailsElement>('.tree-folder').forEach((other) => {
        if (other !== folder) other.open = false;
      });
    },
    true
  );
}

function updateFolderVisibility(hasFilter: boolean) {
  document.querySelectorAll<HTMLDetailsElement>('.tree-folder').forEach((folder) => {
    const hasVisible = !!folder.querySelector('.tree-item:not(.hidden)');
    folder.classList.toggle('hidden', hasFilter && !hasVisible);
    if (hasFilter && hasVisible) folder.open = true;
  });
}

function setSearchStatus(text: string) {
  const el = document.querySelector<HTMLParagraphElement>('#search-status');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

async function runContentSearch(pat: string, term: string) {
  const t = term.trim().toLowerCase();
  const generation = ++searchGeneration;
  if (t.length < CONTENT_SEARCH_MIN_LENGTH) {
    setSearchStatus('');
    return;
  }

  const candidates = Array.from(document.querySelectorAll<HTMLAnchorElement>('.tree-item.hidden'));
  if (!candidates.length) return;

  setSearchStatus('searching file contents…');
  let index = 0;
  const worker = async () => {
    while (index < candidates.length) {
      const el = candidates[index++];
      if (generation !== searchGeneration) return;
      const path = el.getAttribute('data-path')!;
      try {
        const text = await getFileContent(pat, path);
        if (generation !== searchGeneration) return;
        if (text.toLowerCase().includes(t)) {
          el.classList.remove('hidden');
          el.classList.add('content-match');
          updateFolderVisibility(true);
        }
      } catch {
        // background search — individual fetch failures are not worth surfacing
      }
    }
  };
  await Promise.all(Array.from({ length: CONTENT_SEARCH_CONCURRENCY }, worker));
  if (generation === searchGeneration) setSearchStatus('');
}

function updateActiveHighlight(path: string) {
  document.querySelectorAll<HTMLAnchorElement>('.tree-item').forEach((el) => {
    const isActive = el.getAttribute('data-path') === path;
    el.classList.toggle('active', isActive);
    if (isActive) {
      let parent = el.closest('details');
      while (parent) {
        parent.setAttribute('open', '');
        parent = parent.parentElement?.closest('details') ?? null;
      }
    }
  });
  document.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function styleLabelBadges(container: HTMLElement) {
  container.querySelectorAll('code').forEach((code) => {
    const text = code.textContent?.trim() ?? '';
    if (!/^\[.+\]$/.test(text)) return;
    code.classList.add('label-badge');
    if (/dormant/i.test(text)) code.classList.add('label-dormant');
    else if (/reference/i.test(text)) code.classList.add('label-reference');
    else if (/active/i.test(text)) code.classList.add('label-active');
  });
}

async function completeInboxItem(pat: string, path: string) {
  const confirmed = confirm(
    `Remove this from inbox?\n\n${path}\n\nDo this once you've processed or promoted it elsewhere — it can't be undone from here.`
  );
  if (!confirmed) return;

  const completeBtn = document.querySelector<HTMLButtonElement>('#complete-btn')!;
  completeBtn.disabled = true;
  completeBtn.textContent = 'removing…';

  try {
    await deleteInboxFile(pat, path);
    contentCache.delete(path);
    removeFromTree(path);
    removeRecentPage(path);
    location.hash = '#/index.md';
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Could not remove that file.');
    completeBtn.disabled = false;
    completeBtn.textContent = '✓ complete';
  }
}

async function loadPage(pat: string, path: string) {
  const content = document.querySelector<HTMLElement>('#content')!;
  const breadcrumb = document.querySelector<HTMLParagraphElement>('#breadcrumb')!;
  const updatedEl = document.querySelector<HTMLElement>('#last-updated')!;
  const editLink = document.querySelector<HTMLAnchorElement>('#edit-link')!;
  const completeBtn = document.querySelector<HTMLButtonElement>('#complete-btn')!;
  breadcrumb.textContent = path;
  updatedEl.textContent = '';
  editLink.href = githubEditUrl(path);
  completeBtn.hidden = !path.startsWith('inbox/');
  completeBtn.disabled = false;
  completeBtn.textContent = '✓ complete';
  content.innerHTML = '<p class="hint">Loading…</p>';

  try {
    const raw = await getFileContent(pat, path);
    const { meta, body } = parseFrontmatter(raw);
    const withWikilinks = body.replace(/\[\[([a-zA-Z0-9\-_]+)\]\]/g, '[$1](wikilink:$1)');
    content.innerHTML = renderMetaBar(meta, path) + (await marked.parse(withWikilinks));
    rewriteLinks(content, dirOf(path));
    styleLabelBadges(content);
    pushRecentPage(path);
    updateActiveHighlight(path);
    document.querySelector('.content-column')?.scrollTo(0, 0);
    window.scrollTo(0, 0);

    const refreshUpdated = () => {
      fetchLastCommitDate(pat, path).then((iso) => {
        if (iso && currentPath() === path) updatedEl.textContent = `updated ${formatDate(iso)}`;
      });
    };
    refreshUpdated();

    const typeSelect = document.querySelector<HTMLSelectElement>('#type-select');
    typeSelect?.addEventListener('change', () => {
      void updateType(pat, path, typeSelect.value, raw, refreshUpdated);
    });
  } catch (err) {
    updateActiveHighlight(path);
    showError(err, path);
  }
}

async function updateType(pat: string, path: string, newType: string, raw: string, onDone: () => void) {
  const select = document.querySelector<HTMLSelectElement>('#type-select')!;
  select.disabled = true;
  try {
    const newRaw = raw.replace(/^type:.*$/m, `type: ${newType}`);
    await updateFileContent(pat, path, newRaw, `update: ${path} type -> ${newType}`);
    contentCache.set(path, newRaw);
    onDone();
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Could not update type.');
  } finally {
    select.disabled = false;
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
