import { validateToken, configureRepo } from '../github';

const PAT_KEY = 'memory_tools_pat';
const REPO_KEY = 'memory_tools_repo';

export interface RepoConfig {
  owner: string;
  repo: string;
}

export const getPat = () => localStorage.getItem(PAT_KEY);
export const setPat = (pat: string) => localStorage.setItem(PAT_KEY, pat);
export const clearPat = () => localStorage.removeItem(PAT_KEY);

export function getRepo(): RepoConfig | null {
  try {
    return JSON.parse(localStorage.getItem(REPO_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export const setRepo = (config: RepoConfig) => localStorage.setItem(REPO_KEY, JSON.stringify(config));
export const clearRepo = () => localStorage.removeItem(REPO_KEY);

/** Accepts "owner/repo" or a github.com URL (with or without protocol,
 * trailing slash, .git suffix, or extra path segments like /tree/main). */
export function parseRepoInput(input: string): RepoConfig | null {
  const trimmed = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)/i);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };

  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };

  return null;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

export function renderSetupScreen(): string {
  const existingRepo = getRepo();
  const repoValue = existingRepo ? `${existingRepo.owner}/${existingRepo.repo}` : '';
  return `
    <main class="screen setup-screen">
      <h1 class="hero-title">&gt; MEMORY<span class="cursor">_</span></h1>
      <p class="hint">Connect this device to your memory repo. Both fields are stored only in this browser, never sent anywhere but GitHub.</p>
      <form id="setup-form">
        <input id="repo-input" type="text" placeholder="owner/repo or https://github.com/owner/repo" autocomplete="off" spellcheck="false" value="${escapeHtml(repoValue)}" />
        <textarea id="pat-input" placeholder="github_pat_..." rows="3" autocomplete="off" spellcheck="false"></textarea>
        <button type="submit">Save</button>
      </form>
      <p id="error" class="error" hidden></p>
    </main>
  `;
}

export function wireSetupForm(onSaved: () => void) {
  const form = document.querySelector<HTMLFormElement>('#setup-form')!;
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const errorEl = document.querySelector<HTMLParagraphElement>('#error')!;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const repoInput = document.querySelector<HTMLInputElement>('#repo-input')!;
    const patInput = document.querySelector<HTMLTextAreaElement>('#pat-input')!;
    const repoValue = repoInput.value.trim();
    const patValue = patInput.value.trim();
    errorEl.hidden = true;

    const parsedRepo = parseRepoInput(repoValue);
    if (!parsedRepo) {
      errorEl.textContent = 'Enter a repo as owner/repo or a github.com URL.';
      errorEl.hidden = false;
      return;
    }
    if (!patValue) {
      errorEl.textContent = 'Paste a token first.';
      errorEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Validating…';
    try {
      configureRepo(parsedRepo.owner, parsedRepo.repo);
      await validateToken(patValue);
      setPat(patValue);
      setRepo(parsedRepo);
      onSaved();
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : 'Could not validate that token.';
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save';
    }
  });
}
