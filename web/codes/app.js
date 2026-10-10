import { indexedDbStore, requestPersistentStorage } from '../shared/store.js';
import { PERIODS } from '../shared/otp.js';
import {
  confirmDialog, copyText, h, installNote, isIos, isStandalone, mount, openDialog,
  registerServiceWorker, svg, toast, watchVisibility,
} from '../shared/ui.js';
import { FormatException, UserError } from '../shared/util.js';
import { CodesController, MIN_APP_PASSPHRASE } from './controller.js';

const root = document.getElementById('app');
const store = indexedDbStore('tbd-codes');
const codes = new CodesController(store);

const IDLE_LOCK_MS = 2 * 60 * 1000;
const GRACE_CHOICES = [[0, 'Immediately'], [30, 'After 30 seconds'], [60, 'After 1 minute']];
const RING_RADIUS = 108;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const ui = { graceSeconds: 30, lastActivity: Date.now(), notice: '' };
let shownPhase = null;
let ticker = null;

function friendly(error) {
  if (error instanceof UserError || error instanceof FormatException) return error.message;
  console.error(error);
  return 'Something went wrong. Nothing was changed.';
}

function setMessage(text) {
  const el = document.getElementById('msg');
  if (el) el.textContent = text;
}

async function attempt(action) {
  setMessage('');
  try {
    return await action();
  } catch (error) {
    setMessage(friendly(error));
    return undefined;
  }
}

const msgLine = () => h('p', { id: 'msg', class: 'error', role: 'alert' }, codes.message || '');
const brand = () => h('div', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: '', width: 44, height: 44 }), h('b', null, 'TBD Codes'));

function passwordField(label, props = {}) {
  return h('label', { class: 'field' }, label, h('input', {
    type: 'password', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', ...props,
  }));
}

/* -------------------------------- Screens ----------------------------- */

function installScreen() {
  return h('main', { class: 'screen' },
    brand(),
    h('h1', null, 'Add to Home Screen first'),
    h('p', null, 'On iPhone, a website and the app on your Home Screen keep separate storage. Install first, then pair inside the installed app, or the pairing will not carry over.'),
    h('ol', { class: 'steps' },
      h('li', null, 'Tap the Share button in Safari.'),
      h('li', null, 'Choose “Add to Home Screen”, then Add.'),
      h('li', null, 'Open TBD Codes from your Home Screen.')),
    h('button', { class: 'link muted', type: 'button', onClick: () => { sessionStorage.setItem('tbd-browser-ok', '1'); render(); } },
      'Continue in the browser anyway (data will not move to the installed app)'));
}

function setupScreen() {
  const pairing = h('textarea', {
    rows: '3', placeholder: 'TBD1-…', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    'aria-label': 'Pairing code', class: 'mono',
  });
  const pass = passwordField('App passphrase', { autocomplete: 'new-password' });
  const again = passwordField('Repeat passphrase', { autocomplete: 'new-password' });
  const paste = h('button', { class: 'btn secondary small', type: 'button', onClick: async () => {
    try { pairing.value = await navigator.clipboard.readText(); } catch { toast('Paste it into the box by hand.'); }
  } }, 'Paste from clipboard');
  const form = h('form', { class: 'card', onSubmit: async (event) => {
    event.preventDefault();
    await attempt(() => codes.pair(pairing.value, pass.querySelector('input').value, again.querySelector('input').value));
  } },
    h('ol', { class: 'steps' },
      h('li', null, 'In TBD Vault, open Settings and tap “Show pairing code”, then Copy.'),
      h('li', null, 'Paste the code below.'),
      h('li', null, 'Choose a passphrase that protects this app.')),
    h('label', { class: 'field' }, 'Pairing code', pairing), paste,
    pass, again, msgLine(),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Pair with Vault'));
  return h('main', { class: 'screen' },
    brand(),
    h('h1', null, 'Pair with your vault'),
    form,
    h('p', { class: 'hint' }, `Use at least ${MIN_APP_PASSPHRASE} characters. This only protects the codes on this device.`),
    installNote('TBD Codes'));
}

function lockedScreen() {
  const pass = passwordField('App passphrase', { autocomplete: 'current-password' });
  const form = h('form', { class: 'card', onSubmit: async (event) => {
    event.preventDefault();
    const input = pass.querySelector('input');
    const ok = await attempt(() => codes.unlock(input.value));
    if (!ok) { input.value = ''; setMessage(codes.message); input.focus(); }
  } }, pass, msgLine(), h('button', { class: 'btn primary block', type: 'submit' }, 'Show code'));
  return h('main', { class: 'screen' },
    brand(),
    h('h1', null, 'Codes locked'),
    form,
    h('button', { class: 'link muted', type: 'button', onClick: eraseDevice }, 'Remove pairing from this device'),
    installNote('TBD Codes'));
}

function showScreen() {
  const track = svg('circle', { class: 'ring-track', cx: 130, cy: 130, r: RING_RADIUS, fill: 'none', 'stroke-width': 14 });
  const bar = svg('circle', {
    class: 'ring-bar', cx: 130, cy: 130, r: RING_RADIUS, fill: 'none', 'stroke-width': 14,
    'stroke-dasharray': RING_LENGTH, 'stroke-dashoffset': 0,
  });
  const ring = h('div', { class: 'ring-wrap', role: 'timer', 'aria-label': 'Time left for this code' });
  const digits = h('div', { class: 'code-digits', id: 'digits', 'aria-live': 'off' }, '········');
  const left = h('div', { class: 'code-left', id: 'left' }, ' ');
  ring.append(svg('svg', { viewBox: '0 0 260 260', 'aria-hidden': 'true' }, track, bar), h('div', { class: 'ring-center' }, digits, left));

  let lastCode = '';
  let busy = false;
  let currentMsLeft = 0;

  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = await codes.current();
      if (!now) return;
      currentMsLeft = now.msLeft;
      if (now.code !== lastCode) {
        lastCode = now.code;
        digits.textContent = `${now.code.slice(0, 4)} ${now.code.slice(4)}`;
        digits.dataset.code = now.code;
      }
      const fraction = now.msLeft / (codes.period * 1000);
      bar.setAttribute('stroke-dashoffset', String(RING_LENGTH * (1 - fraction)));
      left.textContent = `${Math.ceil(now.msLeft / 1000)}s`;
      ring.classList.toggle('low', now.msLeft < 2000);
    } finally {
      busy = false;
    }
  };
  clearInterval(ticker);
  ticker = setInterval(refresh, 100);
  refresh();

  const copy = h('button', { class: 'btn primary block', type: 'button', onClick: async () => {
    const code = digits.dataset.code;
    if (!code) return;
    // Do not offer a code that is about to expire.
    if (currentMsLeft < 1200) await new Promise((r) => setTimeout(r, currentMsLeft + 150));
    await refresh();
    copyText(digits.dataset.code, 'Code', 15000);
  } }, 'Copy code');

  const segments = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Seconds between new codes' },
    PERIODS.map((p) => h('button', {
      type: 'button', 'aria-pressed': String(p === codes.period),
      onClick: async (event) => {
        await attempt(() => codes.setPeriod(p));
        for (const b of segments.children) b.setAttribute('aria-pressed', String(Number(b.textContent) === codes.period));
        event.target.blur();
        lastCode = '';
        refresh();
      },
    }, String(p))));

  return h('main', { class: 'screen' },
    brand(),
    ring,
    copy,
    h('div', { class: 'card' },
      h('div', { class: 'field' }, 'New code every (seconds)', segments),
      h('p', { class: 'hint' }, 'TBD Vault accepts the code whichever interval you pick here.')),
    msgLine(),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn secondary small', type: 'button', onClick: () => codes.lock() }, 'Lock'),
      h('button', { class: 'btn ghost small', type: 'button', onClick: settingsSheet }, 'Settings')));
}

function settingsSheet() {
  return openDialog('Settings', (close) => {
    const grace = h('select', { 'aria-label': 'Lock when I leave the app', onChange: async (event) => {
      ui.graceSeconds = Number(event.target.value);
      await store.set('prefs', { graceSeconds: ui.graceSeconds });
    } }, GRACE_CHOICES.map(([value, label]) => h('option', { value, selected: value === ui.graceSeconds }, label)));
    return [
      h('label', { class: 'field' }, 'Lock when I leave the app', grace),
      h('p', { class: 'hint' }, 'A short delay lets you copy a code, switch to TBD Vault and back without typing your passphrase each time.'),
      h('button', { class: 'btn danger', type: 'button', onClick: async () => { close(); await eraseDevice(); } }, 'Remove pairing from this device'),
      h('p', { class: 'hint' }, 'TBD Codes 0.1. Everything stays on this device. The app makes no network requests.'),
    ];
  });
}

async function eraseDevice() {
  const ok = await confirmDialog('Remove pairing?', 'This deletes the saved pairing from this device. You can pair again from TBD Vault’s Settings.', 'Remove', { danger: true });
  if (!ok) return;
  await codes.eraseDevice();
  toast('Pairing removed.');
}

/* ------------------------------- Render ------------------------------- */

function render() {
  clearInterval(ticker);
  if (isIos() && !isStandalone() && sessionStorage.getItem('tbd-browser-ok') !== '1') {
    return mount(root, installScreen());
  }
  switch (codes.phase) {
    case 'setup': return mount(root, setupScreen());
    case 'locked': return mount(root, lockedScreen());
    case 'show': return mount(root, showScreen());
    case 'error': return mount(root, h('main', { class: 'screen' }, brand(), h('p', { class: 'banner' }, codes.message)));
    default: return mount(root, h('main', { class: 'screen center' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' })));
  }
}

codes.addEventListener('change', () => {
  document.body.toggleAttribute('data-busy', codes.busy);
  if (codes.phase !== shownPhase) {
    shownPhase = codes.phase;
    render();
  } else if (codes.phase !== 'show') {
    setMessage(codes.message);
  }
});

/* -------------------------- Locking and startup ----------------------- */

watchVisibility({
  onHidden: () => {
    clearInterval(ticker);
    if (codes.phase === 'show' && ui.graceSeconds === 0) codes.lock();
  },
  onVisible: (away) => {
    if (codes.phase === 'show') {
      if (away > ui.graceSeconds * 1000) codes.lock();
      else render();
    }
  },
});

for (const type of ['pointerdown', 'keydown', 'scroll']) {
  window.addEventListener(type, () => { ui.lastActivity = Date.now(); }, { passive: true });
}
setInterval(() => {
  if (codes.phase === 'show' && Date.now() - ui.lastActivity > IDLE_LOCK_MS) codes.lock();
}, 5000);

registerServiceWorker();
requestPersistentStorage();
render();
try {
  const prefs = await store.get('prefs');
  if ([0, 30, 60].includes(prefs?.graceSeconds)) ui.graceSeconds = prefs.graceSeconds;
} catch { /* defaults are fine */ }
await codes.init();
