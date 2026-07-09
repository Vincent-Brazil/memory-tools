export type ThemeId = 'retro' | 'gemini';
const THEME_KEY = 'memory_tools_theme';

const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'retro', label: 'Retro' },
  { id: 'gemini', label: 'Gemini Dark' },
];

export function getTheme(): ThemeId {
  return localStorage.getItem(THEME_KEY) === 'gemini' ? 'gemini' : 'retro';
}

export function applyTheme(id: ThemeId) {
  if (id === 'gemini') {
    document.documentElement.setAttribute('data-theme', 'gemini');
  } else {
    document.documentElement.removeAttribute('data-theme');
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
