import { MAX_BACKUP_BYTES, MIN_BACKUP_PASSWORD } from '../shared/crypto.js';
import { indexedDbStore, requestPersistentStorage } from '../shared/store.js';
import {
  clearClipboard, confirmDialog, copyText, formatDate, h, installNote, isIos, isStandalone, mount,
  openDialog, pickFile, randomPassword, registerServiceWorker, saveFile, toast, watchVisibility,
} from '../shared/ui.js';
import { FaceLock } from '../shared/face.js';
import { FormatException, UserError } from '../shared/util.js';
import { VaultController } from './controller.js';

const root = document.getElementById('app');
const store = indexedDbStore('tbd-vault');
const face = new FaceLock(store, 'TBD Vault');
const vault = new VaultController(store, face);

const IDLE_LOCK_MS = 2 * 60 * 1000;
const CODE_STEP_KEEP_MS = 60 * 1000;
const GRACE_CHOICES = [[0, 'Immediately'], [30, 'After 30 seconds'], [60, 'After 1 minute']];

const ui = {
  selectedId: null,
  adding: false,
  editing: false,
  showPassword: false,
  search: '',
  restore: false,
  restoreFile: null,
  graceSeconds: 0,
  external: false, // true while a file picker or share sheet is open
  lastActivity: Date.now(),
  notice: '',
};
let shownPhase = null;

/* ------------------------------- Helpers ------------------------------ */

function friendly(error) {
  if (error instanceof UserError || error instanceof FormatException) return error.message;
  console.error(error);
  return 'Something went wrong. Nothing was changed.';
}

function setMessage(text) {
  const el = document.getElementById('msg');
  if (el) el.textContent = text;
}

/** Runs an action from a form; shows any problem in the message line. */
async function attempt(action) {
  setMessage('');
  try {
    return await action();
  } catch (error) {
    setMessage(friendly(error));
    return undefined;
  }
}

async function external(action) {
  ui.external = true;
  try {
    return await action();
  } finally {
    ui.external = false;
  }
}

const msgLine = () => h('p', { id: 'msg', class: 'error', role: 'alert' }, vault.message && vault.message !== ui.notice ? vault.message : '');

function brand(title) {
  return h('div', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: '', width: 44, height: 44 }), h('b', null, title));
}

function passwordField(label, props = {}) {
  return h('label', { class: 'field' }, label, h('input', {
    type: 'password', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', ...props,
  }));
}

/* -------------------------------- Screens ----------------------------- */

function installScreen() {
  return h('main', { class: 'screen' },
    brand('TBD Vault'),
    h('h1', null, 'Add to Home Screen first'),
    h('p', null, 'On iPhone, a website and the app on your Home Screen keep separate storage. Install first, then create your vault inside the installed app, or it will not carry over.'),
    h('ol', { class: 'steps' },
      h('li', null, 'Tap the Share button in Safari.'),
      h('li', null, 'Choose “Add to Home Screen”, then Add.'),
      h('li', null, 'Open TBD Vault from your Home Screen.')),
    h('button', { class: 'link muted', type: 'button', onClick: () => { sessionStorage.setItem('tbd-browser-ok', '1'); render(); } },
      'Continue in the browser anyway (data will not move to the installed app)'));
}

function setupScreen() {
  return h('main', { class: 'screen' },
    brand('TBD Vault'),
    h('h1', null, 'Your passwords, kept on this device only'),
    h('p', { class: 'muted' }, 'No account, no server. Works offline once installed.'),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'Face lock (face, fingerprint or your phone PIN) protects everything here. You will be asked for it each time you open the vault.'),
      msgLine(),
      h('button', { class: 'btn primary block', type: 'button', onClick: () => attempt(() => vault.create()) }, 'Set up face lock and create vault')),
    h('button', { class: 'btn ghost block', type: 'button', onClick: () => { ui.restore = true; render(); } }, 'Restore from an encrypted backup'),
    installNote('TBD Vault'));
}

function restoreScreen() {
  const backupPass = passwordField('Backup password', { name: 'backup' });
  const fileLabel = h('p', { class: 'hint' }, ui.restoreFile ? `Selected: ${ui.restoreFile.name}` : 'No file chosen');
  const form = h('form', { class: 'card', onSubmit: async (event) => {
    event.preventDefault();
    await attempt(async () => {
      if (!ui.restoreFile) throw new UserError('Choose your .tbdbackup file first');
      if (vault.phase === 'locked' && !(await confirmDialog('Replace this vault?', 'This erases the vault currently on this device and replaces it with the backup.', 'Replace', { danger: true }))) return;
      const ok = await vault.importBackup(ui.restoreFile.bytes, backupPass.querySelector('input').value);
      if (ok) ui.restoreFile = null;
    });
  } },
    h('button', { class: 'btn secondary', type: 'button', onClick: () => attempt(async () => {
      const picked = await external(() => pickFile(MAX_BACKUP_BYTES));
      if (!picked) return;
      if (!picked.name.toLowerCase().endsWith('.tbdbackup')) throw new UserError('Choose a .tbdbackup file');
      ui.restoreFile = picked;
      fileLabel.textContent = `Selected: ${picked.name}`;
    }) }, 'Choose backup file'),
    fileLabel, backupPass,
    h('p', { class: 'hint' }, 'After restoring, you will set up face lock on this device.'),
    msgLine(),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Restore'));
  return h('main', { class: 'screen' },
    brand('TBD Vault'),
    h('h1', null, 'Restore backup'),
    form,
    h('button', { class: 'btn ghost block', type: 'button', onClick: () => { ui.restore = false; ui.restoreFile = null; render(); } }, 'Back'));
}

function lockedScreen() {
  return h('main', { class: 'screen' },
    brand('TBD Vault'),
    h('h1', null, 'Vault locked'),
    h('div', { class: 'card' },
      msgLine(),
      h('button', { class: 'btn primary block', type: 'button', onClick: async () => {
        const ok = await attempt(() => vault.unlock());
        if (!ok) setMessage(vault.message);
      } }, 'Unlock with face')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'link muted', type: 'button', onClick: () => { ui.restore = true; render(); } }, 'Restore from backup'),
      h('button', { class: 'link muted', type: 'button', onClick: eraseDevice }, 'Erase this device')),
    installNote('TBD Vault'));
}

function legacyScreen() {
  return h('main', { class: 'screen' },
    brand('TBD Vault'),
    h('h1', null, 'Older data found'),
    h('p', { class: 'banner' }, 'This device holds data from an earlier test version that cannot be opened by this one. Restore a backup, or erase it and start again.'),
    h('button', { class: 'btn secondary block', type: 'button', onClick: () => { ui.restore = true; render(); } }, 'Restore from an encrypted backup'),
    h('button', { class: 'btn danger block', type: 'button', onClick: eraseDevice }, 'Erase and start again'));
}

function keySheet() {
  return openDialog('Security key', () => {
    let text;
    try { text = vault.pairingCode(); } catch (error) { return h('p', { class: 'error' }, friendly(error)); }
    return [
      h('div', { class: 'pairing mono', 'aria-label': 'Security key' }, text),
      h('button', { class: 'btn primary', type: 'button', onClick: () => copyText(text, 'Security key', 60000) }, 'Copy security key'),
      h('p', { class: 'hint' }, 'Keep this private.'),
    ];
  });
}

function codeScreen() {
  const input = h('input', {
    class: 'code-input mono', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Eight-digit code', placeholder: '00000000',
  });
  let sending = false;
  const submit = async () => {
    if (sending) return;
    sending = true;
    const value = input.value.trim();
    const ok = await attempt(() => vault.verifyCode(value));
    sending = false;
    if (ok) clearClipboard();
    else { input.value = ''; setMessage(vault.message); input.focus(); }
  };
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 8);
    if (input.value.length === 8) submit();
  });
  return h('main', { class: 'screen' },
    brand('TBD Vault'),
    h('h1', null, 'Security code'),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'Enter your current 8-digit code.'),
      input, msgLine(),
      h('button', { class: 'btn primary block', type: 'button', onClick: submit }, 'Open vault')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn secondary small', type: 'button', onClick: keySheet }, 'Show security key'),
      h('button', { class: 'btn ghost small', type: 'button', onClick: () => vault.lock() }, 'Lock')));
}

/* ------------------------------ Open vault ---------------------------- */

function openScreen() {
  const data = vault.data;
  const selected = data.entries.find((e) => e.id === ui.selectedId);
  const detailOpen = ui.adding || ui.editing || Boolean(selected);

  const search = h('input', { type: 'search', placeholder: 'Search accounts', 'aria-label': 'Search accounts', value: ui.search, autocomplete: 'off' });
  search.addEventListener('input', () => { ui.search = search.value; renderList(); });

  const listHost = h('div', { class: 'list', id: 'list' });
  const detailHost = h('section', { class: 'detail', id: 'detail' });
  const main = h('div', { class: `main${detailOpen ? ' showing-detail' : ''}` }, listHost, detailHost);

  function renderList() {
    const term2 = ui.search.trim().toLowerCase();
    const visible = data.entries
      .filter((e) => !term2 || [e.name, e.site, e.username].some((v) => v.toLowerCase().includes(term2)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    listHost.replaceChildren(...backupBanner(), ...(visible.length
      ? visible.map((e) => h('button', {
        class: 'item', type: 'button', 'aria-current': e.id === ui.selectedId ? 'true' : 'false',
        onClick: () => { ui.selectedId = e.id; ui.adding = ui.editing = ui.showPassword = false; render(); },
      }, h('span', { class: 'name' }, e.name), h('span', { class: 'sub' }, [e.username, e.site].filter(Boolean).join(' · ') || ' ')))
      : [h('p', { class: 'empty' }, data.entries.length ? 'No accounts match your search.' : 'No accounts yet. Tap Add to save your first password.')]));
  }
  renderList();
  detailHost.replaceChildren(ui.adding || ui.editing ? entryForm(selected) : selected ? entryView(selected) : h('p', { class: 'empty' }, 'Select an account to see its details.'));

  return [
    h('header', { class: 'app-bar' },
      h('div', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: 'TBD Vault', width: 36, height: 36 }), h('b', null, 'TBD Vault')),
      h('div', { class: 'grow' }, search),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Backup', title: 'Backup', onClick: backupSheet }, '⇩'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Settings', title: 'Settings', onClick: settingsSheet }, '⚙'),
      h('button', { class: 'btn secondary small', type: 'button', onClick: () => vault.lock() }, 'Lock')),
    main,
    h('button', { class: 'btn primary fab', type: 'button', onClick: () => { ui.adding = true; ui.editing = false; ui.selectedId = null; render(); } }, '+ Add'),
  ];
}

function backupBanner() {
  const data = vault.data;
  if (data.lastBackupRevision < 0) {
    return [h('div', { class: 'banner' }, h('p', null, 'Make your first encrypted backup before adding passwords. Without one, losing this phone loses everything.'),
      h('button', { class: 'btn primary small', type: 'button', onClick: backupSheet }, 'Create backup'))];
  }
  if (vault.backupOutdated) {
    return [h('div', { class: 'banner' }, h('p', null, 'Your backup is older than your latest change.'),
      h('button', { class: 'btn secondary small', type: 'button', onClick: backupSheet }, 'Back up now'))];
  }
  return [];
}

function kv(label, value, { mono = false, copy } = {}) {
  return h('div', { class: 'kv' }, h('span', { class: 'k' }, label),
    h('div', { class: 'row' }, h('span', { class: `v grow${mono ? ' mono' : ''}` }, value),
      copy ? h('button', { class: 'btn ghost small', type: 'button', onClick: () => copyText(copy.text, copy.label) }, 'Copy') : null));
}

function entryView(entry) {
  return h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('button', { class: 'icon-btn back', type: 'button', 'aria-label': 'Back to list', onClick: () => { ui.selectedId = null; ui.showPassword = false; render(); } }, '‹'),
      h('h2', { class: 'grow' }, entry.name)),
    entry.site ? kv('Website or platform', entry.site) : null,
    entry.username ? kv('Username', entry.username, { copy: { text: entry.username, label: 'Username' } }) : null,
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Password'),
      h('div', { class: 'row' },
        h('span', { class: 'v mono grow' }, ui.showPassword ? entry.password : '••••••••••••'),
        h('button', { class: 'btn ghost small', type: 'button', 'aria-pressed': String(ui.showPassword), onClick: () => { ui.showPassword = !ui.showPassword; render(); } }, ui.showPassword ? 'Hide' : 'Show'),
        h('button', { class: 'btn ghost small', type: 'button', onClick: () => copyText(entry.password, 'Password') }, 'Copy'))),
    h('p', { class: 'hint' }, `Updated ${formatDate(entry.updatedAt)}`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn danger', type: 'button', onClick: () => deleteEntry(entry) }, 'Delete'),
      h('button', { class: 'btn secondary', type: 'button', onClick: () => { ui.editing = true; render(); } }, 'Edit')));
}

function entryForm(entry) {
  const field = (label, name, value = '', props = {}) =>
    h('label', { class: 'field' }, label, h('input', { name, value, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', ...props }));
  const name = field('Account name', 'name', entry?.name, { required: true, autocapitalize: 'words' });
  const site = field('Website or platform', 'site', entry?.site);
  const user = field('Username', 'username', entry?.username);
  const password = field('Password', 'password', entry?.password, { type: ui.showPassword ? 'text' : 'password', required: true });
  const pwInput = password.querySelector('input');
  return h('form', { class: 'card', onSubmit: async (event) => {
    event.preventDefault();
    await attempt(async () => {
      const id = await vault.saveEntry({
        id: entry?.id, name: name.querySelector('input').value, site: site.querySelector('input').value,
        username: user.querySelector('input').value, password: pwInput.value,
      });
      ui.selectedId = id; ui.adding = ui.editing = ui.showPassword = false;
      render();
      toast('Saved.');
    });
  } },
    h('div', { class: 'row' },
      h('button', { class: 'icon-btn back', type: 'button', 'aria-label': 'Cancel', onClick: closeForm }, '‹'),
      h('h2', { class: 'grow' }, entry ? 'Edit account' : 'Add account')),
    name, site, user, password,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn secondary small', type: 'button', onClick: () => { pwInput.type = 'text'; pwInput.value = randomPassword(20); } }, 'Generate strong password'),
      h('button', { class: 'btn ghost small', type: 'button', onClick: () => { pwInput.type = pwInput.type === 'password' ? 'text' : 'password'; } }, 'Show / hide')),
    msgLine(),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onClick: closeForm }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
}

function closeForm() {
  ui.adding = ui.editing = ui.showPassword = false;
  render();
}

async function deleteEntry(entry) {
  if (!(await confirmDialog('Delete this account?', `“${entry.name}” will be removed from this vault. Older backups still contain it.`, 'Delete', { danger: true }))) return;
  await attempt(async () => {
    await vault.deleteEntry(entry.id);
    ui.selectedId = null; ui.showPassword = false;
    render();
    toast('Deleted.');
  });
}

/* ------------------------------ Sheets -------------------------------- */

function backupSheet() {
  return openDialog('Encrypted backup', (close) => {
    const body = h('div', { class: 'stack' });
    const data = vault.data;
    const status = data.lastBackupRevision < 0 ? 'No backup yet.' : vault.backupOutdated ? 'Your backup is older than your latest change.' : 'Your backup is up to date.';

    const create = () => {
      const pass = passwordField(`Backup password (at least ${MIN_BACKUP_PASSWORD} characters)`, { autocomplete: 'new-password' });
      const again = passwordField('Repeat backup password', { autocomplete: 'new-password' });
      const msg = h('p', { class: 'error', role: 'alert' });
      const go = h('button', { class: 'btn primary', type: 'submit' }, 'Create backup');
      return h('form', { class: 'stack', onSubmit: async (event) => {
        event.preventDefault();
        const a = pass.querySelector('input').value;
        if (a !== again.querySelector('input').value) { msg.textContent = 'The two passwords do not match'; return; }
        go.disabled = true; go.replaceChildren(h('span', { class: 'spinner' }), ' Encrypting…');
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
        try {
          const { bytes, revision } = await vault.exportBackup(a);
          const filename = `TBD-Vault-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.tbdbackup`;
          body.replaceChildren(
            h('p', { class: 'banner ok' }, 'Backup is ready and was checked. Save it somewhere safe, and keep the password in a different place.'),
            h('button', { class: 'btn primary', type: 'button', onClick: async () => {
              const result = await external(() => saveFile(bytes, filename));
              if (result === 'cancelled') return;
              await vault.markBackedUp(revision);
              render(); toast('Backup saved.'); close(true);
            } }, 'Save backup file'),
            h('p', { class: 'hint' }, 'The file is encrypted with your backup password. Anyone with both can read your passwords.'));
        } catch (error) {
          msg.textContent = friendly(error); go.disabled = false; go.textContent = 'Create backup';
        }
      } }, pass, again, msg, go);
    };

    const test = () => {
      let picked = null;
      const pass = passwordField('Backup password');
      const label = h('p', { class: 'hint' }, 'No file chosen');
      const msg = h('p', { class: 'error', role: 'alert' });
      return h('form', { class: 'stack', onSubmit: async (event) => {
        event.preventDefault();
        msg.textContent = ''; msg.className = 'error';
        try {
          if (!picked) throw new UserError('Choose a backup file first');
          const count = await vault.testBackup(picked.bytes, pass.querySelector('input').value);
          msg.className = 'banner ok'; msg.textContent = `This backup opens correctly and holds ${count} account${count === 1 ? '' : 's'}. Your vault was not changed.`;
        } catch (error) { msg.textContent = friendly(error); }
      } },
      h('button', { class: 'btn secondary', type: 'button', onClick: async () => {
        try {
          const file = await external(() => pickFile(MAX_BACKUP_BYTES));
          if (file) { picked = file; label.textContent = `Selected: ${file.name}`; }
        } catch (error) { msg.textContent = friendly(error); }
      } }, 'Choose backup file'),
      label, pass, msg, h('button', { class: 'btn primary', type: 'submit' }, 'Test backup'));
    };

    body.append(h('p', null, status), h('h3', null, 'Create'), create(), h('h3', null, 'Check an existing backup'), test());
    return body;
  });
}

function settingsSheet() {
  return openDialog('Settings', (close) => {
    const grace = h('select', { 'aria-label': 'Lock when I leave the app', onChange: async (event) => {
      ui.graceSeconds = Number(event.target.value);
      await store.set('prefs', { graceSeconds: ui.graceSeconds });
    } }, GRACE_CHOICES.map(([value, label]) => h('option', { value, selected: value === ui.graceSeconds }, label)));
    const strength = h('p', { class: 'hint' }, 'Face lock: checking…');
    vault.faceStrength().then((mode) => {
      strength.textContent = mode === 'strong'
        ? 'Face lock: strong. The key that protects your data comes from your face or fingerprint.'
        : 'Face lock: basic. This browser cannot tie the key to your face, so it works as a screen lock.';
    });
    return [
      h('button', { class: 'btn secondary', type: 'button', onClick: () => { close(); keySheet(); } }, 'Show security key'),
      h('label', { class: 'field' }, 'Lock when I leave the app', grace),
      strength,
      h('h3', null, 'Danger zone'),
      h('button', { class: 'btn danger', type: 'button', onClick: async () => { close(); await eraseDevice(); } }, 'Erase this vault from the device'),
      h('p', { class: 'hint' }, 'TBD Vault 0.2. Everything stays on this device. The app makes no network requests.'),
    ];
  });
}

async function eraseDevice() {
  const ok = await confirmDialog('Erase this device?', 'This permanently deletes the vault on this device. You can only get your passwords back from an encrypted backup.', 'Erase everything', { danger: true });
  if (!ok) return;
  await vault.eraseDevice();
  ui.restore = false;
  toast('Vault erased from this device.');
}

/* ------------------------------- Render ------------------------------- */

function render() {
  if (isIos() && !isStandalone() && sessionStorage.getItem('tbd-browser-ok') !== '1') {
    return mount(root, installScreen());
  }
  switch (vault.phase) {
    case 'setup': return mount(root, ui.restore ? restoreScreen() : setupScreen());
    case 'locked': return mount(root, ui.restore ? restoreScreen() : lockedScreen());
    case 'legacy': return mount(root, ui.restore ? restoreScreen() : legacyScreen());
    case 'code': return mount(root, codeScreen());
    case 'open': return mount(root, openScreen());
    case 'error':
      return mount(root, h('main', { class: 'screen' }, brand('TBD Vault'), h('p', { class: 'banner' }, vault.message)));
    default:
      return mount(root, h('main', { class: 'screen center' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' })));
  }
}

vault.addEventListener('change', () => {
  document.body.toggleAttribute('data-busy', vault.busy);
  if (vault.phase !== shownPhase) {
    shownPhase = vault.phase;
    ui.notice = vault.message;
    if (vault.phase !== 'open') {
      Object.assign(ui, { selectedId: null, adding: false, editing: false, showPassword: false, search: '' });
    }
    if (!['setup', 'locked', 'legacy'].includes(vault.phase)) ui.restore = false;
    render();
  } else if (vault.message !== ui.notice) {
    setMessage(vault.message);
  }
});

/* -------------------------- Locking and startup ----------------------- */

watchVisibility({
  onHidden: () => {
    if (ui.external) return;
    if (vault.phase === 'open' && ui.graceSeconds === 0) vault.lock();
  },
  onVisible: (away) => {
    if (ui.external) return;
    if (vault.phase === 'open' && away > ui.graceSeconds * 1000) vault.lock();
    else if (vault.phase === 'code' && away > CODE_STEP_KEEP_MS) vault.lock();
  },
});

for (const type of ['pointerdown', 'keydown', 'scroll']) {
  window.addEventListener(type, () => { ui.lastActivity = Date.now(); }, { passive: true });
}
setInterval(() => {
  if (vault.phase === 'open' && !ui.external && Date.now() - ui.lastActivity > IDLE_LOCK_MS) vault.lock();
}, 5000);

registerServiceWorker();
requestPersistentStorage();
render();
try {
  const prefs = await store.get('prefs');
  if ([0, 30, 60].includes(prefs?.graceSeconds)) ui.graceSeconds = prefs.graceSeconds;
} catch { /* defaults are fine */ }
await vault.init();
