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
  configureRepo,
  type MarkdownFile,
} from '../github';
import { getPat, clearPat, getRepo, clearRepo, renderSetupScreen, wireSetupForm } from '../shared/auth';
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
let pendingEnterAnim: 'enter-next' | 'enter-prev' | null = null;
const INBOX_TYPES = ['idea', 'task', 'link'];
const SWIPE_THRESHOLD = 60;
const GRAPH_FETCH_CONCURRENCY = 6;
const STALE_INBOX_DAYS = 14;

type GraphLabel = 'active' | 'dormant' | 'reference';

interface GraphNode {
  path: string;
  label: GraphLabel | null;
  // Inbox items never carry an [active]/[dormant]/[reference] label — their
  // idea/task/link type is a separate axis, worth its own color since it's
  // otherwise invisible on the graph.
  type: string | null;
  issues: string[];
  suggestions: string[];
  x: number;
  y: number;
}

interface GraphEdge {
  source: string;
  target: string;
  inferred?: boolean;
}

// Common words filtered out before scoring content overlap between files —
// deliberately small and blunt (this only needs to beat "shares a stopword"
// as a bar, not do real NLP).
const STOPWORDS = new Set([
  'the', 'and', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'this', 'that', 'it',
  'as', 'by', 'or', 'be', 'at', 'from', 'not', 'but', 'if', 'so', 'we', 'i', 'you', 'your', 'our', 'can', 'will',
  'would', 'should', 'could', 'has', 'have', 'had', 'do', 'does', 'did', 'than', 'then', 'there', 'their', 'they',
  'them', 'he', 'she', 'his', 'her', 'its', 'my', 'me', 'us', 'also', 'just', 'into', 'over', 'under', 'about',
  'more', 'most', 'some', 'any', 'all', 'each', 'other', 'such', 'only', 'own', 'same', 'no', 'nor', 'too', 'very',
  'one', 'two', 'three', 'new', 'via', 'per', 'out', 'up', 'down', 'off', 'how', 'what', 'when', 'where', 'why',
  'which', 'who', 'whom', 'been', 'being', 'because', 'while', 'after', 'before', 'both', 'once', 'here', 'again',
  // Pure URL-structure artifacts from link captures (github.com/owner/repo)
  // — always present, never topical, and without these every link share
  // "matches" every other link share regardless of what it's actually about.
  'github', 'com', 'https', 'http', 'www',
]);

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
  const repo = getRepo();
  if (!pat || !repo) {
    app.innerHTML = renderSetupScreen();
    wireSetupForm(boot);
    return;
  }
  configureRepo(repo.owner, repo.repo);

  app.innerHTML = shell();
  wireShell(pat);

  try {
    const files: MarkdownFile[] = await fetchMarkdownTree(pat);
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
  wireKeyboardNav();
  await route(pat);
  window.addEventListener('hashchange', () => void route(pat));
}

// "graph" is a reserved route, never a real content path (all real paths end
// in .md, per fetchMarkdownTree's filter), so it can't collide with a file.
function route(pat: string): Promise<void> {
  return currentPath() === 'graph' ? showGraphView(pat) : loadPage(pat, currentPath());
}

function shell(): string {
  return `
    <div class="viewer">
      <button id="sidebar-toggle" class="sidebar-toggle-btn" type="button" aria-label="Toggle navigation">&#9776;</button>
      <div class="top-controls">
        <a href="../" class="ctrl-btn" aria-label="Back to Capture"><span class="ctrl-label">&lt; capture</span></a>
      </div>
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">&gt; memory</span>
          ${renderSettingsWidget()}
        </div>
        <div class="tree-home"><a href="#/graph" class="tree-item graph-link">&#9711; graph</a></div>
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
  pendingEnterAnim = delta > 0 ? 'enter-next' : 'enter-prev';
  location.hash = `#/${encodeURIComponent(navOrder[next])}`;
}

function playPageEnterAnimation(content: HTMLElement) {
  if (!pendingEnterAnim) return;
  const cls = pendingEnterAnim;
  pendingEnterAnim = null;
  content.classList.remove('enter-next', 'enter-prev');
  void content.offsetWidth; // force reflow so the animation restarts even if the same class is reused
  content.classList.add(cls);
}

function prefetchNeighbors(pat: string, path: string) {
  const idx = navOrder.indexOf(path);
  if (idx === -1) return;
  const neighbors = [navOrder[idx - 1], navOrder[idx + 1]].filter(
    (p): p is string => Boolean(p) && !contentCache.has(p)
  );
  if (!neighbors.length) return;
  const run = () => neighbors.forEach((p) => void getFileContent(pat, p).catch(() => {}));
  const ric = (window as typeof window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 2000 });
  else setTimeout(run, 300);
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
      navigateRelative(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );
}

function wireKeyboardNav() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    // Don't hijack arrow keys while typing/selecting in a form control.
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    navigateRelative(e.key === 'ArrowRight' ? 1 : -1);
  });
}

function wireShell(pat: string) {
  wireSettingsWidget(() => {
    clearPat();
    clearRepo();
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
        if (other === folder) return;
        if (other.contains(folder)) return; // never collapse an ancestor of the folder that just opened
        other.open = false;
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
  // Scoped to the real tree, not #recent-pages: while browsing within a
  // folder, "where am I" is the tree's job (it opens the containing
  // folder) — recent is for jumping back to something else, so the
  // current file shouldn't also light up there.
  document.querySelectorAll<HTMLAnchorElement>('#tree .tree-item').forEach((el) => {
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
  document.querySelector<HTMLElement>(`#tree .tree-item[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
  document.querySelector<HTMLElement>('.graph-link')?.classList.toggle('active', path === 'graph');
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
  editLink.hidden = false;
  completeBtn.hidden = !path.startsWith('inbox/');
  completeBtn.disabled = false;
  completeBtn.textContent = '✓ complete';
  content.classList.remove('graph-view');
  content.classList.add('doc');
  content.innerHTML = '<p class="hint">Loading…</p>';

  try {
    const raw = await withRetry(() => getFileContent(pat, path));
    const { meta, body } = parseFrontmatter(raw);
    const withWikilinks = body.replace(/\[\[([a-zA-Z0-9\-_]+)\]\]/g, '[$1](wikilink:$1)');
    content.innerHTML = renderMetaBar(meta, path) + (await marked.parse(withWikilinks));
    rewriteLinks(content, dirOf(path));
    styleLabelBadges(content);
    pushRecentPage(path);
    updateActiveHighlight(path);
    document.querySelector('.content-column')?.scrollTo(0, 0);
    window.scrollTo(0, 0);
    playPageEnterAnimation(content);
    prefetchNeighbors(pat, path);

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
    pendingEnterAnim = null;
    updateActiveHighlight(path);
    showError(err, path, () => loadPage(pat, path));
  }
}

const CAPTURE_RECENT_KEY = 'memory_tools_recent';

function syncCaptureRecentType(path: string, newType: string) {
  try {
    const list = JSON.parse(localStorage.getItem(CAPTURE_RECENT_KEY) ?? '[]') as { path?: string; type?: string }[];
    let changed = false;
    for (const item of list) {
      if (item.path === path) {
        item.type = newType;
        changed = true;
      }
    }
    if (changed) localStorage.setItem(CAPTURE_RECENT_KEY, JSON.stringify(list));
  } catch {
    // best-effort cross-app cache sync only — never block the actual edit on this
  }
}

async function updateType(pat: string, path: string, newType: string, raw: string, onDone: () => void) {
  const select = document.querySelector<HTMLSelectElement>('#type-select')!;
  select.disabled = true;
  try {
    const newRaw = raw.replace(/^type:.*$/m, `type: ${newType}`);
    await updateFileContent(pat, path, newRaw, `update: ${path} type -> ${newType}`);
    contentCache.set(path, newRaw);
    syncCaptureRecentType(path, newType);
    onDone();
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Could not update type.');
  } finally {
    select.disabled = false;
  }
}

// The `[active — ...]` / `[dormant]` / `[reference — ...]` badge convention
// used throughout the repo always sits in a backtick span near the top of
// the doc, right under the H1 — mirrors styleLabelBadges' classification,
// just run against raw markdown instead of rendered <code> elements.
function extractLabel(body: string): GraphLabel | null {
  const match = body.slice(0, 400).match(/`(\[[^\]]+\])`/);
  if (!match) return null;
  const text = match[1];
  if (/dormant/i.test(text)) return 'dormant';
  if (/reference/i.test(text)) return 'reference';
  if (/active/i.test(text)) return 'active';
  return null;
}

function extractLinks(body: string, path: string, knownPaths: Set<string>): { resolved: Set<string>; broken: string[] } {
  const resolved = new Set<string>();
  const broken: string[] = [];
  const baseDir = dirOf(path);

  const wikiRe = /\[\[([a-zA-Z0-9\-_]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRe.exec(body))) {
    const slug = m[1];
    const target = slugIndex.get(slug);
    if (target && knownPaths.has(target)) resolved.add(target);
    else broken.push(`[[${slug}]]`);
  }

  const mdLinkRe = /\]\(([^)]+\.md)(?:#[^)]*)?\)/g;
  while ((m = mdLinkRe.exec(body))) {
    const rel = m[1];
    if (/^https?:\/\//.test(rel)) continue;
    const target = resolveRelative(baseDir, rel);
    if (knownPaths.has(target)) resolved.add(target);
    else broken.push(rel);
  }

  return { resolved, broken };
}

// Top N most-frequent significant words in a doc, used as a cheap
// content "signature" for inferring relatedness — no embeddings/backend,
// just enough to beat noise for a triage hint.
function extractTerms(body: string): Set<string> {
  const words = body
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[\[([a-z0-9\-_]+)\]\]/g, ' $1 ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
  const freq = new Map<string, number>();
  words.forEach((w) => freq.set(w, (freq.get(w) ?? 0) + 1));
  return new Set(
    Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([w]) => w)
  );
}

// Shared *rare* terms count for more than shared common ones (a cheap
// IDF stand-in) — otherwise words generic to this whole corpus (memory,
// claude, capture...) would dominate every match with no real signal.
function scoreOverlap(a: Set<string>, b: Set<string>, docFreq: Map<string, number>): { score: number; shared: string[] } {
  const shared: { term: string; weight: number }[] = [];
  a.forEach((term) => {
    if (!b.has(term)) return;
    shared.push({ term, weight: 1 / Math.log2(2 + (docFreq.get(term) ?? 1)) });
  });
  shared.sort((x, y) => y.weight - x.weight);
  return { score: shared.reduce((sum, s) => sum + s.weight, 0), shared: shared.slice(0, 4).map((s) => s.term) };
}

// The searchable "name" for a plain-text mention check — for most files
// that's just the basename, but every skill file is literally named
// SKILL.md, so the meaningful name is its folder instead.
function searchableName(path: string): string {
  const skillMatch = path.match(/^\.claude\/skills\/([^/]+)\//);
  if (skillMatch) return skillMatch[1];
  return path.split('/').pop()!.replace(/\.md$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function buildGraphData(pat: string, paths: string[]): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const knownPaths = new Set(paths);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const termsByPath = new Map<string, Set<string>>();
  const bodyByPath = new Map<string, string>();

  let index = 0;
  const worker = async () => {
    while (index < paths.length) {
      const path = paths[index++];
      try {
        const raw = await getFileContent(pat, path);
        const { meta, body } = parseFrontmatter(raw);
        const { resolved, broken } = extractLinks(body, path, knownPaths);
        const issues = broken.map((b) => `broken link: ${b}`);
        termsByPath.set(path, extractTerms(body));
        bodyByPath.set(path, body);

        if (path.startsWith('inbox/') && meta.captured) {
          const capturedDate = new Date(meta.captured);
          if (!Number.isNaN(capturedDate.getTime())) {
            const ageDays = Math.floor((Date.now() - capturedDate.getTime()) / 86_400_000);
            if (ageDays > STALE_INBOX_DAYS) issues.push(`stale in inbox (${ageDays}d)`);
          }
        }

        const type = path.startsWith('inbox/') && meta.type ? meta.type : null;
        nodes.set(path, { path, label: extractLabel(body), type, issues, suggestions: [], x: 0, y: 0 });
        outgoing.set(path, resolved.size);
        resolved.forEach((target) => {
          const key = [path, target].sort().join('|');
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            edges.push({ source: path, target });
          }
          incoming.set(target, (incoming.get(target) ?? 0) + 1);
        });
      } catch {
        nodes.set(path, { path, label: null, type: null, issues: ['could not load'], suggestions: [], x: 0, y: 0 });
      }
    }
  };
  await Promise.all(Array.from({ length: GRAPH_FETCH_CONCURRENCY }, worker));

  const docFreq = new Map<string, number>();
  termsByPath.forEach((terms) => terms.forEach((t) => docFreq.set(t, (docFreq.get(t) ?? 0) + 1)));

  nodes.forEach((node) => {
    const hasLinks = (outgoing.get(node.path) ?? 0) > 0 || (incoming.get(node.path) ?? 0) > 0;
    if (hasLinks) return;

    // A fresh inbox capture with no links yet is expected, not a defect —
    // a flat "orphaned" flag on every single one is just noise. Infer
    // likely-related existing content instead, to help triage it.
    if (node.path.startsWith('inbox/')) {
      const myTerms = termsByPath.get(node.path);
      if (!myTerms?.size) return;
      const scored: { path: string; score: number; shared: string[] }[] = [];
      termsByPath.forEach((terms, otherPath) => {
        if (otherPath === node.path) return;
        const { score, shared } = scoreOverlap(myTerms, terms, docFreq);
        if (shared.length >= 2) scored.push({ path: otherPath, score, shared });
      });
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 2);
      top.forEach((m) => edges.push({ source: node.path, target: m.path, inferred: true }));
      node.suggestions = top.map((m) => `${m.path} (${m.shared.join(', ')})`);
    } else if (node.path !== 'index.md') {
      const name = searchableName(node.path);
      const mentioned =
        name.length >= 4 &&
        Array.from(bodyByPath.entries()).some(
          ([otherPath, body]) => otherPath !== node.path && new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(body)
        );
      if (!mentioned) node.issues.push('orphaned (no links in or out)');
    }
  });

  return { nodes: [...nodes.values()], edges };
}

// A minimal force-directed layout (repulsion + spring edges + mild
// centering), settled synchronously over a fixed number of iterations —
// no need for a physics library or continuous animation for a graph this
// size, and a static settle-then-render is simpler than a live simulation.
function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number) {
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2.4;
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    n.x = cx + Math.cos(angle) * radius * (0.4 + Math.random() * 0.6);
    n.y = cy + Math.sin(angle) * radius * (0.4 + Math.random() * 0.6);
  });

  const REPULSION = 2600;
  const SPRING = 0.02;
  const SPRING_LEN = 70;
  const CENTER_PULL = 0.006;
  const STEP = 0.05;

  for (let iter = 0; iter < 220; iter++) {
    const fx = new Map<string, number>();
    const fy = new Map<string, number>();
    nodes.forEach((n) => {
      fx.set(n.path, 0);
      fy.set(n.path, 0);
    });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const distSq = dx * dx + dy * dy || 0.01;
        const dist = Math.sqrt(distSq);
        const force = REPULSION / distSq;
        dx /= dist;
        dy /= dist;
        fx.set(a.path, fx.get(a.path)! + dx * force);
        fy.set(a.path, fy.get(a.path)! + dy * force);
        fx.set(b.path, fx.get(b.path)! - dx * force);
        fy.set(b.path, fy.get(b.path)! - dy * force);
      }
    }

    edges.forEach((e) => {
      const a = byPath.get(e.source);
      const b = byPath.get(e.target);
      if (!a || !b) return;
      // Inferred edges are a hint, not a fact — pull gently toward the
      // related cluster rather than snapping to it like a real link.
      const springK = e.inferred ? SPRING * 0.35 : SPRING;
      const springLen = e.inferred ? SPRING_LEN * 1.6 : SPRING_LEN;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const displacement = (dist - springLen) * springK;
      dx /= dist;
      dy /= dist;
      fx.set(a.path, fx.get(a.path)! + dx * displacement);
      fy.set(a.path, fy.get(a.path)! + dy * displacement);
      fx.set(b.path, fx.get(b.path)! - dx * displacement);
      fy.set(b.path, fy.get(b.path)! - dy * displacement);
    });

    nodes.forEach((n) => {
      const fxv = fx.get(n.path)! + (cx - n.x) * CENTER_PULL;
      const fyv = fy.get(n.path)! + (cy - n.y) * CENTER_PULL;
      n.x += fxv * STEP;
      n.y += fyv * STEP;
    });
  }
}

const GRAPH_LABEL_COLORS: Record<GraphLabel, string> = {
  active: 'var(--success)',
  dormant: 'var(--muted)',
  reference: 'var(--accent)',
};

// A different color family from the status labels above — type and status
// are separate axes (a curated doc has a status; an inbox item has a type;
// in practice a node never has both), so distinct hues keep it readable
// which axis a given color is telling you about.
const GRAPH_TYPE_COLORS: Record<string, string> = {
  idea: 'var(--accent-blue)',
  task: 'var(--accent-warm)',
  link: 'var(--accent-pink)',
};

function renderGraphSvg(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): string {
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const edgeLines = edges
    .map((e) => {
      const a = byPath.get(e.source);
      const b = byPath.get(e.target);
      if (!a || !b) return '';
      const cls = e.inferred ? 'graph-edge inferred' : 'graph-edge';
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="${cls}" />`;
    })
    .join('');

  const nodeEls = nodes
    .map((n) => {
      const color = n.label ? GRAPH_LABEL_COLORS[n.label] : n.type ? GRAPH_TYPE_COLORS[n.type] ?? 'var(--border)' : 'var(--border)';
      const flagged = n.issues.length > 0;
      const suggestionText = n.suggestions.map((s) => `related: ${s}`);
      const tooltip = [n.path, n.type ? `type: ${n.type}` : '', ...n.issues, ...suggestionText].filter(Boolean).join(' — ');
      const filterKey = n.label ?? n.type ?? 'none';
      return `
        <a href="#/${encodeURIComponent(n.path)}" class="graph-node${flagged ? ' flagged' : ''}" data-filter="${filterKey}">
          <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${flagged ? 7 : 5}" fill="${color}" />
          <title>${tooltip}</title>
        </a>
      `;
    })
    .join('');

  return `<svg class="graph-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
    <g class="graph-edges">${edgeLines}</g>
    <g class="graph-nodes">${nodeEls}</g>
  </svg>`;
}

function renderGraphToolbar(nodes: GraphNode[]): string {
  const flagged = nodes.filter((n) => n.issues.length > 0);
  const counts: Record<'active' | 'dormant' | 'reference' | 'idea' | 'task' | 'link' | 'none', number> = {
    active: nodes.filter((n) => n.label === 'active').length,
    dormant: nodes.filter((n) => n.label === 'dormant').length,
    reference: nodes.filter((n) => n.label === 'reference').length,
    idea: nodes.filter((n) => n.type === 'idea').length,
    task: nodes.filter((n) => n.type === 'task').length,
    link: nodes.filter((n) => n.type === 'link').length,
    none: nodes.filter((n) => !n.label && !n.type).length,
  };
  const chip = (key: string, text: string, count: number) =>
    `<button type="button" class="graph-chip" data-filter="${key}" aria-pressed="true">${text} <span class="graph-chip-count">${count}</span></button>`;

  const issuesPanel = flagged.length
    ? `<details class="graph-issues">
        <summary>${flagged.length} data quality issue${flagged.length === 1 ? '' : 's'}</summary>
        <ul class="graph-issues-list">
          ${flagged
            .map(
              (n) =>
                `<li><a href="#/${encodeURIComponent(n.path)}">${n.path}</a><span class="graph-issue-text">${n.issues.join('; ')}</span></li>`
            )
            .join('')}
        </ul>
      </details>`
    : `<p class="graph-issues-clean">no data quality issues found</p>`;

  const suggested = nodes.filter((n) => n.suggestions.length > 0);
  const suggestionsPanel = suggested.length
    ? `<details class="graph-suggestions">
        <summary>${suggested.length} inbox item${suggested.length === 1 ? '' : 's'} with suggested relations</summary>
        <ul class="graph-suggestions-list">
          ${suggested
            .map(
              (n) =>
                `<li><a href="#/${encodeURIComponent(n.path)}">${n.path}</a><span class="graph-suggestion-text">related to ${n.suggestions.join('; ')}</span></li>`
            )
            .join('')}
        </ul>
      </details>`
    : '';

  return `
    <div class="graph-toolbar">
      <div class="graph-filters">
        ${chip('active', 'active', counts.active)}
        ${chip('dormant', 'dormant', counts.dormant)}
        ${chip('reference', 'reference', counts.reference)}
        ${chip('idea', 'idea', counts.idea)}
        ${chip('task', 'task', counts.task)}
        ${chip('link', 'link', counts.link)}
        ${chip('none', 'unlabeled', counts.none)}
      </div>
      ${issuesPanel}
      ${suggestionsPanel}
    </div>
  `;
}

function applyGraphFilter() {
  const activeFilters = new Set(
    Array.from(document.querySelectorAll<HTMLButtonElement>('.graph-chip[aria-pressed="true"]')).map((c) => c.dataset.filter)
  );
  document.querySelectorAll<SVGAElement>('.graph-node').forEach((node) => {
    const key = node.getAttribute('data-filter') || 'none';
    node.classList.toggle('dimmed', !activeFilters.has(key));
  });
}

function wireGraphFilters() {
  document.querySelectorAll<HTMLButtonElement>('.graph-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const pressed = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', String(!pressed));
      chip.classList.toggle('off', pressed);
      applyGraphFilter();
    });
  });
}

async function showGraphView(pat: string) {
  const breadcrumb = document.querySelector<HTMLParagraphElement>('#breadcrumb')!;
  const updatedEl = document.querySelector<HTMLElement>('#last-updated')!;
  const editLink = document.querySelector<HTMLAnchorElement>('#edit-link')!;
  const completeBtn = document.querySelector<HTMLButtonElement>('#complete-btn')!;
  const content = document.querySelector<HTMLElement>('#content')!;

  breadcrumb.textContent = 'graph';
  updatedEl.textContent = '';
  editLink.hidden = true;
  completeBtn.hidden = true;
  updateActiveHighlight('graph');
  content.classList.remove('doc');
  content.classList.add('graph-view');
  content.innerHTML = '<p class="hint">Building graph…</p>';

  try {
    const { nodes, edges } = await buildGraphData(pat, navOrder);
    const width = 900;
    const height = 640;
    layoutGraph(nodes, edges, width, height);
    content.innerHTML = renderGraphToolbar(nodes) + renderGraphSvg(nodes, edges, width, height);
    wireGraphFilters();
    document.querySelector('.content-column')?.scrollTo(0, 0);
  } catch (err) {
    showError(err, undefined, () => void showGraphView(pat));
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

function showError(err: unknown, path?: string, onRetry?: () => void) {
  const content = document.querySelector<HTMLElement>('#content');
  const message = err instanceof Error ? err.message : 'Something went wrong.';
  if (!content) return;
  content.innerHTML = `
    <p class="error">${message}</p>
    <p class="error-actions">
      ${onRetry ? '<button id="retry-btn" type="button" class="retry-btn">retry</button>' : ''}
      ${path && path !== 'index.md' ? '<a href="#/index.md">&larr; back to index</a>' : ''}
    </p>
  `;
  if (onRetry) document.querySelector<HTMLButtonElement>('#retry-btn')!.addEventListener('click', onRetry);
}

// One silent retry for likely-transient failures (network blips, 5xx) before
// giving up — auth/not-found errors aren't transient, so skip the delay for those.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/token rejected|not found in memory/i.test(message)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 700));
    return fn();
  }
}

boot();
