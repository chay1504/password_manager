// Small DOM helpers. Content is always added as text, never as HTML, so a
// saved account name can never run as script.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (name === 'class') {
      el.className = value;
    } else if (name === 'value') {
      el.value = value;
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs ?? {})) el.setAttribute(name, String(value));
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(root, ...children) {
  root.replaceChildren(...children.flat(Infinity).filter(Boolean));
}

/* ------------------------------ Toasts ------------------------------ */

export function toast(message, { action, onAction, ms = 4000 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const item = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', null, message),
    action ? h('button', { class: 'link', type: 'button', onClick: () => { onAction?.(); item.remove(); } }, action) : null,
  );
  host.append(item);
  if (!action) setTimeout(() => item.remove(), ms);
}

/* ------------------------------ Dialogs ----------------------------- */

/** Opens a modal sheet. `build(close)` returns the content. Resolves when closed. */
export function openDialog(title, build) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'sheet', 'aria-label': title });
    const close = (result) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(undefined);
    });
    dialog.append(
      h('div', { class: 'sheet-head' }, h('h2', null, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: () => close(undefined) }, '×')),
      h('div', { class: 'sheet-body' }, build(close)),
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function confirmDialog(title, message, confirmLabel, { danger = false } = {}) {
  return openDialog(title, (close) => [
    h('p', null, message),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onClick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onClick: () => close(true) }, confirmLabel)),
  ]).then(Boolean);
}

/* ------------------------------ Clipboard --------------------------- */

let clipboardTimer;

/** Copies text, then blanks the clipboard after `clearAfterMs` if the page is still open. */
export async function copyText(text, label, clearAfterMs = 20000) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Copy was blocked by the browser. Select the text and copy it by hand.');
    return false;
  }
  toast(`${label} copied. It is cleared from the clipboard after ${Math.round(clearAfterMs / 1000)} seconds.`);
  clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(() => clearClipboard(), clearAfterMs);
  return true;
}

export async function clearClipboard() {
  clearTimeout(clipboardTimer);
  try {
    await navigator.clipboard.writeText('');
  } catch {
    /* Not allowed while the page is in the background. */
  }
}

/* --------------------------- Files and sharing ---------------------- */

/** Offers the file to the share sheet (Save to Files) or downloads it. Must run from a tap. */
export async function saveFile(bytes, filename) {
  const file = new File([bytes], filename, { type: 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
      /* fall through to a normal download */
    }
  }
  const url = URL.createObjectURL(file);
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}

/** Lets the user choose a local file. Resolves with the bytes and name, or null. */
export function pickFile(maxBytes) {
  return new Promise((resolve, reject) => {
    const input = h('input', { type: 'file', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      if (file.size > maxBytes) return reject(new Error('That file is too large to be a backup.'));
      resolve({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}

/* ------------------------- Install and updates ---------------------- */

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  window.dispatchEvent(new Event('tbd-installable'));
});

/** A short "add to home screen" note, or null if already installed. */
export function installNote(appName) {
  if (isStandalone()) return null;
  if (installPrompt) {
    return h('button', {
      class: 'btn secondary', type: 'button',
      onClick: async () => {
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null;
      },
    }, `Install ${appName} on this device`);
  }
  return h('p', { class: 'hint' },
    isIos()
      ? `To install: tap the Share button, then “Add to Home Screen”.`
      : `To install: open the browser menu and choose “Install app” or “Add to Home screen”.`);
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const hadController = Boolean(navigator.serviceWorker.controller);
      const registration = await navigator.serviceWorker.register('./sw.js');
      const announce = (worker) =>
        toast('A new version is ready.', {
          action: 'Reload',
          onAction: () => worker.postMessage('SKIP_WAITING'),
        });
      if (registration.waiting && navigator.serviceWorker.controller) announce(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
        });
      });
      // Reload only for an update, not on the very first install.
      navigator.serviceWorker.addEventListener('controllerchange', () => hadController && location.reload());
    } catch {
      /* Offline install is optional; the app still works online. */
    }
  });
}

/* --------------------------- Leaving the app ------------------------ */

/**
 * Covers the screen the moment the page is hidden (so the app switcher shows
 * nothing) and reports how long it was away when it returns.
 */
export function watchVisibility({ onHidden, onVisible }) {
  let hiddenAt = null;
  const hide = () => {
    document.body.classList.add('covered');
    if (hiddenAt === null) {
      hiddenAt = Date.now();
      onHidden?.();
    }
  };
  const show = () => {
    document.body.classList.remove('covered');
    if (hiddenAt !== null) {
      const away = Date.now() - hiddenAt;
      hiddenAt = null;
      onVisible?.(away);
    }
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? hide() : show()));
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', () => !document.hidden && show());
}

export const formatDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function randomPassword(length = 20) {
  const sets = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKMNPQRSTUVWXYZ', '23456789', '!@#$%^&*-_=+?'];
  const all = sets.join('');
  const pick = (chars) => {
    const limit = 256 - (256 % chars.length);
    for (;;) {
      const [byte] = crypto.getRandomValues(new Uint8Array(1));
      if (byte < limit) return chars[byte % chars.length];
    }
  };
  const out = sets.map(pick);
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const [r] = crypto.getRandomValues(new Uint32Array(1));
    const j = r % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}
