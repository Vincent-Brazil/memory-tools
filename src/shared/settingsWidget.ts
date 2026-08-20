import { renderThemeSelect, wireThemeSelect } from './theme';
import { getRepo } from './auth';

export function renderSettingsWidget(): string {
  return `
    <div class="settings-widget">
      <button id="settings-fab" class="fab" type="button" aria-label="Settings">&#9881;</button>
      <div id="settings-menu" class="settings-menu" hidden>
        <label class="settings-row">
          <span>Theme</span>
          ${renderThemeSelect()}
        </label>
        <div class="settings-row">
          <span>Source repo</span>
          <code id="settings-repo" class="settings-value"></code>
        </div>
        <button id="disconnect-btn" type="button" class="menu-disconnect">Disconnect device</button>
      </div>
    </div>
  `;
}

export function wireSettingsWidget(onDisconnect: () => void) {
  wireThemeSelect();

  // Read-only, and set as text rather than interpolated into the markup above:
  // parseRepoInput accepts anything without a slash or space, so the stored value
  // can contain HTML metacharacters even though it is only ever self-entered.
  const repoEl = document.querySelector<HTMLElement>('#settings-repo')!;
  const repo = getRepo();
  repoEl.textContent = repo ? `${repo.owner}/${repo.repo}` : 'not connected';

  const fab = document.querySelector<HTMLButtonElement>('#settings-fab')!;
  const menu = document.querySelector<HTMLDivElement>('#settings-menu')!;

  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== fab) {
      menu.hidden = true;
    }
  });

  document.querySelector('#disconnect-btn')!.addEventListener('click', () => {
    if (confirm('Disconnect this device? You will need to paste the token again.')) {
      onDisconnect();
    }
  });
}
