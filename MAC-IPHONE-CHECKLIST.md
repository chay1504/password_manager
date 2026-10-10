# iPhone build and test checklist (needs a Mac)

Nothing in this file has been run yet. The iPhone code was written on Windows and has never been compiled. This includes the clipboard-expiry and app-switcher-cover code in each app's `ios/Runner/AppDelegate.swift`. Expect to fix small Swift compile errors on the first build.

## Before you start
- Mac with current Xcode, the friend's iPhone (passcode and Face ID set), a USB cable.
- Free Personal Team signing works for testing, but installs **expire after 7 days** (re-install with the same bundle ID; data is kept). A paid Apple Developer membership is needed for long-term private installs.
- Free teams may not allow the shared Keychain group the two apps use to pair. Step 4 finds out.

## Steps
1. `flutter pub get` in `apps/vault` and `apps/codes`. Open each `ios/Runner.xcworkspace`.
2. In **Signing & Capabilities** set the same Team on both. Bundle IDs must be unique to that team. If you change one, update the matching `$(AppIdentifierPrefix)` entries in `Runner.entitlements`, and keep both apps' shared group `com.techboydeepak.tbd.shared`.
3. Build to the phone with your 10-character Team ID in both apps:
   `flutter run --release --dart-define=TBD_TEAM_ID=YOUR_TEAM_ID`
4. **Shared Keychain check:** in TBD Vault create a vault, then in TBD Codes tap Pair with Vault. If pairing fails with a Keychain or entitlement error, free signing does not support the shared group. Stop and tell me: pairing then has to change to typed or QR seed transfer, which is a design change.
5. **Authentication:** Face ID prompt, wrong face, then passcode fallback, for both apps.
6. **Codes:** try intervals 5, 7 and 10 seconds. Confirm the interval set in Codes is used by Vault.
7. **Code entry:** correct code; wrong code; code that expired while typing; five wrong tries (30 s wait); entering a code that was already used.
8. **App switcher:** with each app open on a screen showing a password or code, swipe up to the app switcher. The preview must be blank/black, not the content.
9. **Clipboard:** copy a code in Codes, switch to Vault and paste it. Copy a password and wait 20 s. Then paste into Notes. It should be empty.
10. **Offline:** repeat the main flow in airplane mode.
11. **Backup:** export a backup, run Test encrypted backup, delete both apps, reinstall, restore, pair again.
12. **Cross-platform:** copy the iPhone-made `.tbdbackup` to an Android phone or emulator and restore it there. Try a wrong password and a file with one byte changed.

## Record the result
Tick each item and note the iOS version. Only after steps 4 to 12 pass is the iPhone pair ready for real passwords.
