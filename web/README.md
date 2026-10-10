# TBD Vault + TBD Codes as web apps (PWAs)

Two separate static websites that install to the home screen like apps. No server code, no accounts, no analytics. After the first visit each one works offline.

| Folder | What it is |
| --- | --- |
| `vault/` | TBD Vault: save, search, edit, copy passwords. Opens with **face lock + an 8-digit code**. |
| `codes/` | TBD Codes: shows the changing 8-digit code (5 to 10 seconds, you choose). Opens with **face lock only**. |
| `shared/` | Encryption, face lock, code generation, key format, styles, fonts, offline helpers used by both. |
| `scripts/` | `build.mjs` (makes `dist/`), `serve.mjs` (local preview), security headers. |
| `test/` | 31 automated tests (`npm test`). |

By design, neither app's screens mention the other. This README is where the link between them is explained.

## Build and test (needs only Node 20+, no installs)

```bash
cd web
npm test          # 31 tests
npm run build     # writes dist/vault and dist/codes (about 0.5 MB each)
npm run serve     # preview: Vault http://localhost:5173, Codes http://localhost:5174
```

## Deploy (you do this; nothing is published automatically)

Deploy `dist/vault` and `dist/codes` as **two separate sites on two different addresses**, over HTTPS, for example `vault.yourdomain.com` and `codes.yourdomain.com`. Different addresses give each app its own private storage and its own face-lock passkey. Face lock only works on HTTPS (or localhost).

- **Vercel:** in each of `dist/vault` and `dist/codes` run `vercel --prod`. The generated `vercel.json` adds the security headers.
- **Netlify or Cloudflare Pages:** upload each folder as its own site. The generated `_headers` file adds the security headers.
- To update, rebuild and redeploy. Installed apps show "A new version is ready" with a Reload button.

## Install on a phone

1. **iPhone:** open the address in **Safari**, tap Share, then **Add to Home Screen**. Do this **before** creating anything: the Home Screen app has separate storage from Safari. **Android:** open in Chrome and tap Install app.
2. Do this for both apps. They appear as two apps with two icons.
3. The phone needs a screen lock (face, fingerprint or PIN) turned on.

## First use (the part the apps don't spell out)

1. **Vault:** tap **Set up face lock and create vault**, approve with face or fingerprint.
2. Vault shows a **Security code** screen. Tap **Show security key**, then **Copy security key**.
3. **Codes:** paste the key into the box and tap **Save and set up face lock**. Approve. A ring and an 8-digit code appear.
4. Tap **Copy code**, switch to Vault, paste it. The vault opens. Vault asks for a first backup before you can add passwords.

Every day: Vault, **Unlock with face**, then in Codes **Unlock with face** and **Copy code**, then paste it into Vault. The key is a one-time copy; it is needed again only when you restore or move to a new phone.

The 5 to 10 second interval is chosen in Codes. Vault accepts any of them, so nothing changes in Vault.

## Passwords: what exists now

- **Vault:** face lock, then the 8-digit code. No typed passphrase.
- **Codes:** face lock only.
- **Backup password:** the only password you type, and only when making, testing or restoring a backup. It protects the backup file that you store elsewhere, so it must be a real password (12+ characters), kept apart from the file.

## How face lock works, and its two strengths

Face lock uses a platform passkey (WebAuthn) that the phone approves with face, fingerprint or PIN.

- **Strong** (iPhone iOS 18 or newer, current Android Chrome): the passkey produces the encryption key itself, so the data cannot be decrypted without a successful face or fingerprint.
- **Basic** (browsers without the PRF feature, for example many desktops): the face prompt still has to be approved, but the key is a non-extractable key kept in browser storage, so it acts as a screen lock rather than being part of the encryption.

Each app's **Settings** shows which one is in use.

If the passkey is deleted or the browser data is cleared, the vault cannot be opened on that device: restore from the encrypted backup. Restoring asks you to set up face lock again and to add the security key to Codes again.

## Honest limits

- The code is a second check on the **same phone**, not an independent second factor.
- No backup and no face lock means no way back. There is no server.
- A browser cannot clear the clipboard while the app is in the background, and cannot guarantee a blank app-switcher preview. The apps cover the screen and wipe the clipboard when they can.
- Vault locks as soon as you leave it (or after 30 or 60 seconds, in Settings). Codes keeps itself unlocked 30 seconds by default so you can copy and switch.
- A phone that is rooted, jailbroken or has malware defeats these protections.

## Not yet verified

Tested: 31 automated tests, and a real-browser run (with a simulated face prompt) of setup, face refusal, lock and unlock, code entry, backup, adding accounts, reload, and phone and desktop layouts. **Not tested:** a real face or fingerprint prompt on a phone, strong mode on iPhone, installing to a home screen, offline use through the service worker (the preview browser cannot run service workers), the iPhone share sheet for backups, and the iPhone app-switcher preview. Test those on the real phones before trusting it with real passwords.
