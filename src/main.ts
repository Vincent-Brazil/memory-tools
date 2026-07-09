import './style.css';
import './shared/theme.css';
import { createInboxEntry, type CaptureType } from './github';
import { getPat, clearPat, renderSetupScreen, wireSetupForm } from './shared/auth';
import { getTheme, applyTheme, renderThemeSelect, wireThemeSelect } from './shared/theme';

applyTheme(getTheme());

const app = document.querySelector<HTMLDivElement>('#app')!;

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
      ${renderThemeSelect()}
      <a href="view/" class="ctrl-btn">View memory</a>
      <button id="settings-btn" class="ctrl-btn" type="button" aria-label="Disconnect this device">&#9881;</button>
    </div>
    <main class="screen">
      <h1 class="hero-title">&#10095; CAPTURE<span class="cursor">_</span></h1>
      <form id="capture-form" class="capture-card">
        <div class="type-toggle" role="radiogroup" aria-label="Type">
          <label><input type="radio" name="type" value="idea" checked /> idea</label>
          <label><input type="radio" name="type" value="task" /> task</label>
          <label><input type="radio" name="type" value="link" /> link</label>
        </div>
        <div class="prompt-box">
          <span class="prompt-arrow">&gt;</span>
          <textarea id="text-input" placeholder="Type your idea, task, or link…" rows="3" required></textarea>
        </div>
        <button type="submit" id="submit-btn">Capture <span class="btn-arrow">&#8629;</span></button>
      </form>
      <p id="status" class="status" hidden></p>
    </main>
    <footer class="status-bar">
      <span class="status-path">~/memory/inbox</span>
      <span class="status-conn">connected</span>
      <span class="status-app">capture</span>
    </footer>
  `;
}

function wireEvents(pat: string) {
  wireThemeSelect();

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
