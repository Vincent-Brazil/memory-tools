import { registerSW } from 'virtual:pwa-register';

export function initUpdatePrompt() {
  const updateSW = registerSW({
    onNeedRefresh() {
      showToast(() => updateSW(true));
    },
  });
}

function showToast(onReload: () => void) {
  if (document.querySelector('.update-toast')) return;
  const el = document.createElement('div');
  el.className = 'update-toast';
  el.innerHTML = `<span>Update available</span><button type="button">Reload</button>`;
  el.querySelector('button')!.addEventListener('click', onReload);
  document.body.appendChild(el);
}
