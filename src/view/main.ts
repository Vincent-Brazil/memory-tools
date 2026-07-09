import '../style.css';
import '../shared/theme.css';
import './view.css';
import { marked } from 'marked';
import { fetchMarkdownTree, fetchFileContent, type MarkdownFile } from '../github';
import { getPat, clearPat, renderSetupScreen, wireSetupForm } from '../shared/auth';
import { getTheme, applyTheme, renderThemeSelect, wireThemeSelect } from '../shared/theme';
import { initUpdatePrompt } from '../shared/updatePrompt';

applyTheme(getTheme());
initUpdatePrompt();

const app = document.querySelector<HTMLDivElement>('#app')!;
const MOBILE_BREAKPOINT = 860;

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  children: TreeNode[];
}

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
    document.querySelector<HTMLElement>('#tree')!.innerHTML = renderTree(tree);
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
      <button id="sidebar-toggle" class="sidebar-toggle-btn" type="button" aria-label="Toggle navigation">&#9776;</button>
      <div class="top-controls">
        ${renderThemeSelect()}
        <a href="../" class="ctrl-btn" aria-label="Back to Capture">&larr; Capture</a>
      </div>
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">memory</span>
          <button id="settings-btn" type="button" aria-label="Disconnect this device">&#9881;</button>
        </div>
        <input id="filter-input" class="sidebar-search" type="search" placeholder="Search…" autocomplete="off" />
        <nav id="tree" class="tree"><p class="hint">Loading…</p></nav>
      </aside>
      <div id="sidebar-backdrop" class="sidebar-backdrop" hidden></div>
      <div class="content-column">
        <p id="breadcrumb" class="breadcrumb"></p>
        <main id="content" class="doc"><p class="hint">Loading…</p></main>
      </div>
    </div>
  `;
}

function wireShell(pat: string) {
  wireThemeSelect();

  document.querySelector('#settings-btn')!.addEventListener('click', () => {
    if (confirm('Disconnect this device? You will need to paste the token again.')) {
      clearPat();
      boot();
    }
  });

  const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
  const backdrop = document.querySelector<HTMLElement>('#sidebar-backdrop')!;
  const toggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!;

  const openSidebar = () => {
    sidebar.classList.add('open');
    backdrop.hidden = false;
  };
  const closeSidebar = () => {
    sidebar.classList.remove('open');
    backdrop.hidden = true;
  };
  toggle.addEventListener('click', () => (sidebar.classList.contains('open') ? closeSidebar() : openSidebar()));
  backdrop.addEventListener('click', closeSidebar);
  sidebar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tree-item') && window.innerWidth <= MOBILE_BREAKPOINT) closeSidebar();
  });

  const filterInput = document.querySelector<HTMLInputElement>('#filter-input')!;
  filterInput.addEventListener('input', () => applyFilter(filterInput.value));

  void pat;
}

function applyFilter(term: string) {
  const t = term.trim().toLowerCase();
  document.querySelectorAll<HTMLAnchorElement>('.tree-item').forEach((el) => {
    const path = el.getAttribute('data-path') || '';
    el.classList.toggle('hidden', Boolean(t) && !path.toLowerCase().includes(t));
  });
  document.querySelectorAll<HTMLDetailsElement>('.tree-folder').forEach((folder) => {
    const hasVisible = !!folder.querySelector('.tree-item:not(.hidden)');
    folder.classList.toggle('hidden', Boolean(t) && !hasVisible);
    if (t && hasVisible) folder.open = true;
  });
}

function updateActiveHighlight(path: string) {
  document.querySelectorAll<HTMLAnchorElement>('.tree-item').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-path') === path);
  });
  const activeEl = document.querySelector<HTMLElement>(`.tree-item[data-path="${CSS.escape(path)}"]`);
  let parent = activeEl?.closest('details');
  while (parent) {
    parent.setAttribute('open', '');
    parent = parent.parentElement?.closest('details') ?? null;
  }
  activeEl?.scrollIntoView({ block: 'nearest' });
}

async function loadPage(pat: string, path: string) {
  const content = document.querySelector<HTMLElement>('#content')!;
  const breadcrumb = document.querySelector<HTMLParagraphElement>('#breadcrumb')!;
  breadcrumb.textContent = path;
  content.innerHTML = '<p class="hint">Loading…</p>';
  updateActiveHighlight(path);

  try {
    const raw = await fetchFileContent(pat, path);
    const withWikilinks = raw.replace(/\[\[([a-zA-Z0-9\-_]+)\]\]/g, '[$1](wikilink:$1)');
    content.innerHTML = await marked.parse(withWikilinks);
    rewriteLinks(content, dirOf(path));
    document.querySelector('.content-column')?.scrollTo(0, 0);
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
