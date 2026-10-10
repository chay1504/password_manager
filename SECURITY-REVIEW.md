# Security review (in progress)

Status date: 2026-10-09. This is a review of the source plus automated tests. It is **not** an independent audit, and **no real-device testing has been done**. Do not store real passwords yet.

## Checked and found sound (source and unit tests)
- Vault file: AES-256-GCM with a random key held in Keychain / Keystore-backed secure storage that requires device authentication. Test: the secret does not appear in clear in `vault.tbd`.
- Backups: Argon2id plus AES-256-GCM with the format name as authenticated data. Tests cover a wrong password and an altered salt, nonce, ciphertext, mac, format or kdf field. Also covered: truncated, garbage, empty and oversize files, and a checked-in v1 fixture that must keep opening.
- Code entry: eight digits only, current interval only, constant-time compare, 5 failures lead to a 30 s lock that survives restart, a corrupt attempts file counts as locked, and an accepted code cannot be reused (also after restart). Covered by `apps/vault/test/vault_controller_test.dart`.
- Release manifests: `INTERNET` appears only in debug and profile manifests; `allowBackup=false` and cloud backup and device transfer are excluded. To be re-confirmed on the built release APK.
- Android pairing provider: guarded by a signature-level permission **and** a runtime signature check on the caller.
- Android screens use `FLAG_SECURE`. Observed: `adb screencap` of the Vault returns an all-black image.
- Debug logging in `apps/codes/lib/main.dart` is inside `assert(...)`, so it is not compiled into release builds.

## Fixed in this pass
- **Clipboard clearing was unreliable.** The old Dart timer would not run once the app that copied was in the background, which is the normal copy-then-switch flow. Now: iPhone uses a local-only pasteboard item with an OS expiry; Android marks the item sensitive, Vault clears a leftover eight-digit code right after code entry, and each app clears its own copy on return to the foreground and by timer while open.

## Known limits (cannot be fully fixed)
- Android has no clipboard expiry. A copied **password** can stay on the clipboard if you switch away and do not return. Other apps could read it on Android 12 and older.
- The code app and vault run on the same phone, so the code is an extra check, not a separate second factor.
- A rooted or jailbroken phone, or malware with device-level access, defeats these protections.
- Losing both the backup password and the backup file means no recovery.

## Not yet verified
- Android end-to-end run, release APK signing and permission check, install-order behaviour (Codes before Vault).
- Everything on iPhone: shared Keychain pairing, Face ID and passcode fallback, app-switcher cover, clipboard expiry, backup import across platforms. See `MAC-IPHONE-CHECKLIST.md`.

---

# Web version (`web/`), review status 2026-10-09

Source and automated-test review plus one real-browser run. **Not an independent audit; no real-phone testing.**

## Checked
- Vault and Codes data are stored only as AES-256-GCM encrypted records (fresh nonce per save). In the browser run, the stored vault contained none of the account name, username or site, and localStorage was empty. Backup files use Argon2id (64 MB x 3) plus AES-256-GCM.
- Unlock is by face lock (platform passkey, user verification required). Strong mode derives the key from the passkey's PRF output; basic mode uses a non-extractable browser key as a screen lock (shown in Settings). The key is held in memory only while unlocked; locking drops it. No typed passphrase exists in either app.
- Code entry: 8 digits, current interval only (any 5 to 10 s setting), no replay of an accepted code (also after lock and restart), 5 misses lead to a 30 s wait that doubles each repeat (up to 10 min).
- Screens in each app never name the other app. The one link, copying the security key, is documented outside the apps in `web/README.md`.
- Backups: tamper tests on every field, truncated and garbage files, oversize and over-heavy key settings are refused. A real backup from the earlier Flutter code opens (cross-implementation test).
- Pages cannot talk to other servers: strict Content-Security-Policy (`connect-src 'self'`, no inline scripts or styles), no third-party scripts, fonts or analytics; the build fails if any remote URL appears.
- Account text is always inserted as text, never as HTML.

## Known limits
- Without the PRF feature (basic mode) face lock is a screen lock, not part of the encryption: someone able to run code in the page's browser profile could use the stored key. Strong mode needs a recent iPhone or Android browser.
- Deleting the passkey or clearing browser data makes the vault unreadable on that device; the backup file is the recovery.
- Clipboard cannot be cleared from the background; the app-switcher preview cannot be guaranteed blank on iPhone.
- The security key, shown on screen and copied to the clipboard, lets anyone who has it generate login codes. It does not open the vault without face lock.
- Browsers can delete site data under storage pressure or when the user clears it; the app asks for persistent storage, but a recent backup is the real protection.

## Not yet verified
- A real face or fingerprint prompt (only a simulated one was used), strong mode on iPhone, real iPhone and Android install, offline use through the service worker, share-sheet backup, app-switcher behaviour.
- Hosting must actually send the security headers (`web/vercel.json` for Git-linked Vercel projects, or the generated `dist/*/vercel.json` and `_headers` for manual deployment).
