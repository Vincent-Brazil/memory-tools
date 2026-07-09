import './style.css';
import { createInboxEntry, type CaptureType } from './github';
import { getPat, clearPat, renderSetupScreen, wireSetupForm } from './shared/auth';

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
    <main class="screen">
      <header class="topbar">
        <h1>Capture</h1>
        <nav class="nav-links">
          <a href="view/">View memory</a>
          <button id="settings-btn" type="button" aria-label="Disconnect this device">&#9881;</button>
        </nav>
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

function wireEvents(pat: string) {
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
