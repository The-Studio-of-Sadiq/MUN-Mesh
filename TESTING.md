# Testing on a phone

The phone app uses native TCP sockets, so it doesn't run in Expo Go. It needs
the **development build**: an APK of this app with Expo's dev client, which
loads the JavaScript from your PC while you work on it.

## 1. Install the development build (once)

1. On the phone, open the build page and tap **Install**. The first
   development build (2026-10-23):
   https://expo.dev/accounts/princekhan/projects/mun-toolkit/builds/68ed9584-a83a-408e-9514-c75ddf2b4e8f
   (all builds: https://expo.dev/accounts/princekhan/projects/mun-toolkit/builds)
   Allow "install unknown apps" for your browser if Android asks.
2. Rebuild only when native code changes (a new native package, or app.json
   permissions/plugins):

   ```bash
   npm run build:android:dev
   ```

   (This runs EAS inside `apps/app`; a plain `npx eas-cli` in this monorepo can
   end up running at the root, which isn't the Expo project.)

## 2. Run the JavaScript from your PC

The phone and PC must be on the same Wi-Fi.

```bash
npm run app
```

Open **MUN Toolkit** on the phone. It lists the dev server; if not, scan the
QR code the terminal prints. JS changes reload on the phone as you save.

## 3. A conference on your desk

1. On the PC, start the Windows app as the Secretariat:

   ```bash
   npm run desktop
   ```

   Choose **Create a conference**. When Windows asks, **allow the app on private
   networks** (TCP 47900 for links, UDP 47901 for laptops finding each other).
2. Optional: a second Windows instance as the committee's EB:
   `npx electron apps/desktop --profile=chair`. Paste the Secretariat's join code
   (Join panel → **Copy join code**), ask to join as Executive Board, and approve it
   on the Secretariat.
3. On the phone: **Scan QR code** → scan the invite on the EB (or Secretariat)
   screen → Delegate, pick the country → **Ask to join**. Approve it in the
   console's **Join** panel.

## 4. What to check on the phone

- [ ] Joining by QR works and the phone shows "Waiting for approval", then the
      committee after approval.
- [ ] Messages from the phone appear on the console within a second, and back.
- [ ] A chit from the phone appears in the EB queue; once approved, another
      device (a second phone, or a second Windows instance as a delegate) can read it.
- [ ] Muting the phone from the console blocks its composer with a message.
- [ ] **Offline behaviour:** turn the phone's Wi-Fi off, post a message (it
      stays on the phone), turn Wi-Fi back on: the message reaches the console,
      and anything sent meanwhile arrives on the phone.
- [ ] Close and reopen the app: history is still there and it reconnects.
- [ ] Two phones in the same committee: a message from one reaches the other through the laptop.

Report anything odd with the phone's model and Android version.

## Without the PC: a standalone APK

To test like a real conference (no dev server, JS built into the APK):

```bash
npm run build:android:preview
```
