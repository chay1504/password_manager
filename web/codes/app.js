import { indexedDbStore, requestPersistentStorage } from '../shared/store.js';
import { PERIODS } from '../shared/otp.js';
import {
  confirmDialog, copyText, h, installNote, isIos, isStandalone, mount, openDialog,
  registerServiceWorker, svg, toast, watchVisibility,
} from '../shared/ui.js';
import { FaceLock } from '../shared/face.js';
import { FormatException, UserError } from '../shared/util.js';
import { CodesController } from './controller.js';

const root = document.getElementById('app');
const store = indexedDbStore('tbd-codes');
const face = new FaceLock(store, 'TBD Codes');
const codes = new CodesController(store, face);

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

/* -------------------------------- Screens ----------------------------- */

function installScreen() {
  return h('main', { class: 'screen' },
    brand(),
    h('h1', null, 'Add to Home Screen first'),
    h('p', null, 'On iPhone, a website and the app on your Home Screen keep separate storage. Install first, then add your key inside the installed app, or it will not carry over.'),
    h('ol', { class: 'steps' },
      h('li', null, 'Tap the Share button in Safari.'),
      h('li', null, 'Choose “Add to Home Screen”, then Add.'),
      h('li', null, 'Open TBD Codes from your Home Screen.')),
    h('button', { class: 'link muted', type: 'button', onClick: () => { sessionStorage.setItem('tbd-browser-ok', '1'); render(); } },
      'Continue in the browser anyway (data will not move to the installed app)'));
}

function setupScreen() {
  const key = h('textarea', {
    rows: '3', placeholder: 'TBD1-…', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    'aria-label': 'Security key', class: 'mono',
  });
  const paste = h('button', { class: 'btn secondary small', type: 'button', onClick: async () => {
    try { key.value = await navigator.clipboard.readText(); } catch { toast('Paste it into the box by hand.'); }
  } }, 'Paste from clipboard');
  const form = h('form', { class: 'card', onSubmit: async (event) => {
    event.preventDefault();
    await attempt(() => codes.add(key.value));
  } },
    h('label', { class: 'field' }, 'Security key', key), paste,
    h('p', { class: 'hint' }, 'Face lock (face, fingerprint or your phone PIN) will protect it.'),
    msgLine(),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Save and set up face lock'));
  return h('main', { class: 'screen' },
    brand(),
    h('h1', null, 'Add your security key'),
    form,
    installNote('TBD Codes'));
}

function lockedScreen() {
  return h('main', { class: 'screen' },
    brand(),
    h('h1', null, 'Locked'),
    h('div', { class: 'card' },
      msgLine(),
      h('button', { class: 'btn primary block', type: 'button', onClick: async () => {
        const ok = await attempt(() => codes.unlock());
        if (!ok) setMessage(codes.message);
      } }, 'Unlock with face')),
    h('button', { class: 'link muted', type: 'button', onClick: eraseDevice }, 'Remove security key from this device'),
    installNote('TBD Codes'));
}

function legacyScreen() {
  return h('main', { class: 'screen' },
    brand(),
    h('h1', null, 'Older data found'),
    h('p', { class: 'banner' }, 'This device holds data from an earlier test version that cannot be opened by this one. Erase it and add your security key again.'),
    h('button', { class: 'btn danger block', type: 'button', onClick: eraseDevice }, 'Erase and start again'));
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
      h('div', { class: 'field' }, 'New code every (seconds)', segments)),
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
    const strength = h('p', { class: 'hint' }, 'Face lock: checking…');
    codes.faceStrength().then((mode) => {
      strength.textContent = mode === 'strong'
        ? 'Face lock: strong. The key that protects your data comes from your face or fingerprint.'
        : 'Face lock: basic. This browser cannot tie the key to your face, so it works as a screen lock.';
    });
    return [
      h('label', { class: 'field' }, 'Lock when I leave the app', grace),
      h('p', { class: 'hint' }, 'A short delay avoids unlocking again each time you switch away and back.'),
      strength,
      h('button', { class: 'btn danger', type: 'button', onClick: async () => { close(); await eraseDevice(); } }, 'Remove security key from this device'),
      h('p', { class: 'hint' }, 'TBD Codes 0.2. Everything stays on this device. The app makes no network requests.'),
    ];
  });
}

async function eraseDevice() {
  const ok = await confirmDialog('Remove security key?', 'This deletes the saved key from this device. You will need the key again to use this app.', 'Remove', { danger: true });
  if (!ok) return;
  await codes.eraseDevice();
  toast('Security key removed.');
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
    case 'legacy': return mount(root, legacyScreen());
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
