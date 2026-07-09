export type ThemeId = 'retro' | 'gemini' | 'claude' | 'godzilla' | 'hackers';
const THEME_KEY = 'memory_tools_theme';

const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'retro', label: 'Retro' },
  { id: 'gemini', label: 'Gemini Dark' },
  { id: 'claude', label: 'Claude' },
  { id: 'godzilla', label: 'Godzilla' },
  { id: 'hackers', label: 'Hackers' },
];
const THEME_IDS = THEMES.map((t) => t.id);

export function getTheme(): ThemeId {
  const stored = localStorage.getItem(THEME_KEY);
  return (THEME_IDS as string[]).includes(stored ?? '') ? (stored as ThemeId) : 'retro';
}

export function applyTheme(id: ThemeId) {
  if (id === 'retro') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', id);
  }
}

export function setTheme(id: ThemeId) {
  localStorage.setItem(THEME_KEY, id);
  applyTheme(id);
}

export function renderThemeSelect(): string {
  const current = getTheme();
  const options = THEMES.map(
    (t) => `<option value="${t.id}"${t.id === current ? ' selected' : ''}>${t.label}</option>`
  ).join('');
  return `<select id="theme-select" class="ctrl-btn theme-select" aria-label="Theme">${options}</select>`;
}

export function wireThemeSelect() {
  const select = document.querySelector<HTMLSelectElement>('#theme-select');
  select?.addEventListener('change', () => setTheme(select.value as ThemeId));
}
