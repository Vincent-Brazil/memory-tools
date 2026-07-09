const PAT_KEY = 'memory_tools_pat';

export const getPat = () => localStorage.getItem(PAT_KEY);
export const setPat = (pat: string) => localStorage.setItem(PAT_KEY, pat);
export const clearPat = () => localStorage.removeItem(PAT_KEY);

export function renderSetupScreen(): string {
  return `
    <main class="screen">
      <h1 class="setup-title">&#10095; Memory Tools</h1>
      <p class="hint">Paste your GitHub token to connect this device. It's stored only in this browser, never sent anywhere but GitHub.</p>
      <form id="setup-form">
        <textarea id="pat-input" placeholder="github_pat_..." rows="3" autocomplete="off" spellcheck="false"></textarea>
        <button type="submit">Save</button>
      </form>
      <p id="error" class="error" hidden></p>
    </main>
  `;
}

export function wireSetupForm(onSaved: () => void) {
  const form = document.querySelector<HTMLFormElement>('#setup-form')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLTextAreaElement>('#pat-input')!;
    const value = input.value.trim();
    const errorEl = document.querySelector<HTMLParagraphElement>('#error')!;
    if (!value) {
      errorEl.textContent = 'Paste a token first.';
      errorEl.hidden = false;
      return;
    }
    setPat(value);
    onSaved();
  });
}
