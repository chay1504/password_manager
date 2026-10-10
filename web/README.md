# TBD Vault + TBD Codes as web apps (PWAs)

Two separate static websites that install to the home screen like apps. No server code, no accounts, no analytics. After the first visit each one works offline.

| Folder | What it is |
| --- | --- |
| `vault/` | TBD Vault: save, search, edit, copy passwords. Opens only with the passphrase **and** an 8-digit code. |
| `codes/` | TBD Codes: shows the changing 8-digit code (5 to 10 seconds, you choose). |
| `shared/` | Encryption, code generation, pairing, styles, fonts, offline helpers used by both. |
| `scripts/` | `build.mjs` (makes `dist/`), `serve.mjs` (local preview), security headers. |
| `test/` | 26 automated tests (`npm test`). |

## Build and test (needs only Node 20+, no installs)

```bash
cd web
npm test          # 26 tests: codes, encryption, backups, lockouts, replays, pairing
npm run build     # writes dist/vault and dist/codes (about 0.5 MB each)
npm run serve     # preview: Vault http://localhost:5173, Codes http://localhost:5174
```

## Deploy

Deploy `dist/vault` and `dist/codes` as **two separate sites on two different addresses**, over HTTPS, for example `vault.yourdomain.com` and `codes.yourdomain.com`. Different addresses are what give each app its own private storage. Do not put them on the same address.

- **Vercel with GitHub:** create two projects from this repository, each with Root Directory `web`, Build Command `npm run build`, Framework Preset `Other`, and Output Directory `dist/vault` or `dist/codes` respectively. `web/vercel.json` applies the security headers to both projects. A push to `main` redeploys both.
- **Vercel manual upload:** in each of `dist/vault` and `dist/codes` run `vercel --prod`. The generated `vercel.json` adds the security headers.
- **Netlify or Cloudflare Pages:** upload each folder as its own site. The generated `_headers` file adds the security headers.
- After deploying, rebuild and redeploy to update. Installed apps show a "new version is ready" message and reload when you tap it.

The headers matter: they stop the pages from loading anything from other servers (`connect-src 'self'`). Check that your host applies them.

## Install on a phone

1. **iPhone:** open the address in **Safari**, tap Share, then **Add to Home Screen**. Do this **before** creating anything. On iPhone, the Home Screen app has separate storage from Safari, and the app will not let you create a vault in Safari. **Android:** open in Chrome and tap Install app.
2. Do this for both TBD Vault and TBD Codes. They appear as two apps with two icons.

## First use

1. Open **TBD Vault**, create a passphrase (12+ characters). Make your first encrypted backup when asked.
2. Vault shows **Show pairing code**. Tap Copy. Open **TBD Codes**, paste it, choose an app passphrase.
3. Codes shows a ring and an 8-digit code. Tap **Copy code**, switch to Vault, paste. The vault opens.
4. Changing the interval (5 to 10 s) in Codes needs no change in Vault.
5. New phone: install both apps, in Vault choose **Restore from an encrypted backup**, pair Codes again.

## What changed from the native apps, and why

- Web pages cannot use the iPhone Keychain or Android Keystore, so the vault is encrypted with your **passphrase** (Argon2id, 64 MB, 3 passes, then AES-256-GCM) instead of a device key.
- Two installed web apps cannot share storage, so pairing is a one-time **copy and paste of a pairing code** instead of a hidden shared channel.
- Backups use the same `TBD-BACKUP-v1` format. A backup made by the earlier Flutter code decrypts in this code (there is a test for that). Web backups use a stronger Argon2 setting, which the Flutter code would reject.

## Honest limits

- The code is a second check on the **same phone**, not an independent second factor. The strength of the vault comes from the passphrase. Choose a long one.
- Lost passphrase and no backup means no way back. There is no server.
- A browser cannot clear the clipboard while the app is in the background, and cannot guarantee a blank app-switcher preview. The apps cover the screen and wipe the clipboard when they can.
- Locking: Vault locks as soon as you leave it, or after 30 seconds or 1 minute if you choose that in Settings. Codes keeps itself unlocked 30 seconds by default so you can copy and switch.
- A phone that is rooted, jailbroken or has malware defeats these protections.

## Not yet verified

Tested: 26 automated tests, plus a real-browser run of create, pair, wrong and right codes, backup, add, search, reload and unlock, with phone-width and desktop layouts. **Not tested:** installing to a real iPhone or Android phone, offline use through the service worker (the preview browser here cannot run service workers), the iPhone share sheet for saving backups, and behaviour in the iPhone app switcher. Test those on the real phones before trusting it with real passwords.
