import { renderThemeSelect, wireThemeSelect } from './theme';

export function renderSettingsWidget(): string {
  return `
    <div class="settings-widget">
      <button id="settings-fab" class="fab" type="button" aria-label="Settings">&#9881;</button>
      <div id="settings-menu" class="settings-menu" hidden>
        <label class="settings-row">
          <span>Theme</span>
          ${renderThemeSelect()}
        </label>
        <button id="disconnect-btn" type="button" class="menu-disconnect">Disconnect device</button>
      </div>
    </div>
  `;
}

export function wireSettingsWidget(onDisconnect: () => void) {
  wireThemeSelect();

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
