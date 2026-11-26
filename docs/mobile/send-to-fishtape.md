# Send to Fishtape: sharing files into the app

A file someone receives by email or text goes straight into **Files** (`#/files`): the Import sheet
opens with a customer/job picker, then the AI files it. Every route ends in the same place: the files
wait in IndexedDB `fishtape-share` until the Files screen takes them (`electrical-app/js/lib/files-share.js`).

| Where | How the file arrives | Code |
| --- | --- | --- |
| Installed PWA (Android Chrome, desktop Chrome/Edge) | Web Share Target: `manifest.webmanifest` `share_target` POSTs multipart to `./share-target`; the service worker stores the files and redirects to `#/files?shared=1` | `electrical-app/manifest.webmanifest`, the share-target block at the end of `electrical-app/sw.js` |
| iOS app | "Open in Fishtape" / Share → Fishtape, from `CFBundleDocumentTypes` (PDF, images, video, Word, Excel, PowerPoint, text/CSV/RTF, email, ZIP) | `SceneDelegate.swift` → `Plugins/FishtapeIncomingFilesPlugin.swift` (JS name `FishtapeIncomingFiles`) |
| Android app | `ACTION_SEND`, `ACTION_SEND_MULTIPLE` and "Open with" `ACTION_VIEW` intent filters | `AndroidManifest.xml`, `FishtapeIncomingFilesPlugin.java`, registered in `MainActivity.java` |

Safari on iOS has no Web Share Target, so on an iPhone/iPad the native app is the way in.

## Verify on a Mac (iOS)

1. `cd mobile && npm run sync && npm run open`, build to a device or simulator.
2. In Files (or Mail → an attachment → Share), pick a PDF → **Fishtape** in the app row (or "Open in…").
   Fishtape opens on Files with the Import sheet listing the file. Choose a customer, Import: the tray
   shows "Filed to … › Permits & inspections" with Undo / Move / Rename.
3. With Fishtape already open in the background, share a second file: the sheet opens again
   (event `filesReceived`).
4. Share a video over 70 MB: a toast says it was too large; nothing is uploaded.
5. Share two photos at once from Photos (the app appears under "Open in" via `public.image`).
6. Sign out, share a file, sign back in, open Files: the "shared file waiting to be filed" banner offers it.
7. Check `tmp/Incoming` is emptied after the hand-over (Xcode → Devices → Download Container).

## Verify on Android

1. `cd mobile && npx cap sync android && npx cap open android` (Android Studio), run on a device.
2. Share a PDF from Gmail or Files → Fishtape: Files opens with the Import sheet.
3. Share several photos from Photos (`SEND_MULTIPLE`); open a PDF with "Open with → Fishtape" (`VIEW`).
4. Rotate the phone after sharing: the files are not offered twice (the intent is consumed).

## A true iOS Share Extension (not built)

The document types above make Fishtape appear in the share sheet's **app row** for supported types and
in "Open in…", which covers Mail, Messages, Files and Photos. A Share Extension adds Fishtape to the
**action list** and lets people share without the app opening. It is a separate target, so it was left
out rather than half-done. To add it:

1. Xcode → File → New → Target → **Share Extension**, name `FishtapeShare`, bundle id
   `com.fishtapehq.app.share`, embed in App. Register the id in App Store Connect
   (`mobile/scripts/register-bundle-id.mjs`) and add a provisioning profile for it.
2. Add an **App Group** (`group.com.fishtapehq.app`) to both the App and the extension (Signing &
   Capabilities), and to both entitlements files.
3. In the extension's `ShareViewController`, load each `NSItemProvider` attachment with
   `loadFileRepresentation(forTypeIdentifier:)` (types `public.data`), copy it into the App Group
   container `Incoming/<uuid>/<name>`, then open the app with a custom URL (`fishtape://files-shared`, add
   it to `CFBundleURLTypes`) or just complete the request with a "Saved to Fishtape" message.
4. In `FishtapeIncomingFiles.take()`, also read (and delete) files waiting in the App Group container.
   Nothing on the web side changes.
5. Set `NSExtensionActivationRule` to a predicate allowing up to 20 files of the types above.
6. Add the extension's own `PrivacyInfo.xcprivacy` (no tracking, no collected data) and run
   `node --test mobile/scripts/privacy-manifest.test.mjs`.
