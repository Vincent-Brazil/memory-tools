import './style.css';
import { createInboxEntry, type CaptureType } from './github';

const PAT_KEY = 'memory_tools_pat';
const app = document.querySelector<HTMLDivElement>('#app')!;

const getPat = () => localStorage.getItem(PAT_KEY);
const setPat = (pat: string) => localStorage.setItem(PAT_KEY, pat);
const clearPat = () => localStorage.removeItem(PAT_KEY);

function render() {
  const pat = getPat();
  app.innerHTML = pat ? captureView() : setupView();
  wireEvents(pat);
}

function setupView() {
  return `
    <main class="screen">
      <h1>Memory Capture</h1>
      <p class="hint">Paste your GitHub token to connect this device. It's stored only in this browser, never sent anywhere but GitHub.</p>
      <form id="setup-form">
        <textarea id="pat-input" placeholder="github_pat_..." rows="3" autocomplete="off" spellcheck="false"></textarea>
        <button type="submit">Save</button>
      </form>
      <p id="error" class="error" hidden></p>
    </main>
  `;
}

function captureView() {
  return `
    <main class="screen">
      <header class="topbar">
        <h1>Capture</h1>
        <button id="settings-btn" type="button" aria-label="Disconnect this device">&#9881;</button>
      </header>
      <form id="capture-form">
        <div class="type-toggle" role="radiogroup" aria-label="Type">
          <label><input type="radio" name="type" value="idea" checked /> Idea</label>
          <label><input type="radio" name="type" value="task" /> Task</label>
          <label><input type="radio" name="type" value="link" /> Link</label>
        </div>
        <textarea id="text-input" placeholder="What's on your mind?" rows="6" required></textarea>
        <button type="submit" id="submit-btn">Capture</button>
      </form>
      <p id="status" class="status" hidden></p>
    </main>
  `;
}

function wireEvents(pat: string | null) {
  if (!pat) {
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
      render();
    });
    return;
  }

  document.querySelector('#settings-btn')!.addEventListener('click', () => {
    if (confirm('Disconnect this device? You will need to paste the token again to capture from here.')) {
      clearPat();
      render();
    }
  });

  const form = document.querySelector<HTMLFormElement>('#capture-form')!;
  const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
  const submitBtn = document.querySelector<HTMLButtonElement>('#submit-btn')!;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = document.querySelector<HTMLTextAreaElement>('#text-input')!.value.trim();
    const type = document.querySelector<HTMLInputElement>('input[name="type"]:checked')!.value as CaptureType;
    if (!text) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Capturing…';
    statusEl.hidden = true;

    try {
      await createInboxEntry(pat, text, type);
      statusEl.textContent = 'Captured.';
      statusEl.className = 'status success';
      statusEl.hidden = false;
      form.reset();
      document.querySelector<HTMLInputElement>('input[name="type"][value="idea"]')!.checked = true;
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : 'Something went wrong.';
      statusEl.className = 'status error';
      statusEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Capture';
    }
  });
}

render();
